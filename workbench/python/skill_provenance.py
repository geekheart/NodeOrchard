"""Private provenance and guarded archival for newly created workbench Skills.

The caller records only a confirmed fresh native creation. Existing Skills are
never inferred to be generated from their name, content or install location.
"""
from __future__ import annotations

from contextlib import contextmanager
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

try:
    import fcntl
except ImportError:  # No unlocked mutation fallback on non-POSIX systems.
    fcntl = None

MAX_BUNDLE_ENTRIES = 2048
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
MAX_LEDGER_BYTES = 64 * 1024
_FORMAT = 'NodeOrchard.skill-provenance'
_OPERATION = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z')
_NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,63}\Z')
_REVISION = re.compile(r'sha256:[a-f0-9]{64}\Z')


def _fail(message='Skill provenance could not be verified.'):
    raise ValueError(message)


def _hash(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def _encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode('utf-8')


def _identity(info):
    if info is None:
        _fail('Skill storage identity is unavailable.')
    return {'dev': info.st_dev, 'ino': info.st_ino}


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _directory(info):
    if not stat.S_ISDIR(info.st_mode):
        _fail('Skill paths must be ordinary directories.')


def _regular(info, maximum):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 <= info.st_size <= maximum:
        _fail('Skill files must be bounded ordinary files without links.')


def _path(value):
    value = Path(value)
    if not value.is_absolute() or '..' in value.parts or '\0' in str(value):
        _fail('Skill storage requires an absolute controlled directory.')
    return value


def _open_directory(path):
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        _fail('Safe Skill directory access is unavailable on this platform.')
    path = _path(path)
    current = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = next_fd
            _directory(os.fstat(current))
        return current
    except BaseException:
        os.close(current)
        raise


def _entry(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _read_file(parent, name, maximum):
    before = _entry(parent, name)
    if before is None:
        raise FileNotFoundError(name)
    _regular(before, maximum)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        opened = os.fstat(fd)
        _regular(opened, maximum)
        if _signature(before) != _signature(opened):
            _fail('Skill file changed while opening it.')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(64 * 1024, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                _fail('Skill file exceeds its size limit.')
        after = os.fstat(fd)
        linked = _entry(parent, name)
        if linked is None or _signature(opened) != _signature(after) or _signature(after) != _signature(linked) or size != opened.st_size:
            _fail('Skill file changed while reading it.')
        return b''.join(chunks), opened
    finally:
        os.close(fd)


def read_skill_bundle(path):
    """Return a complete stable manifest, root identity and two content hashes."""
    try:
        path = _path(path)
        root = _open_directory(path)
        try:
            first = os.fstat(root)
            manifest, total, entries, main = [], 0, 0, None

            def visit(directory, prefix='', depth=0):
                nonlocal total, entries, main
                if depth > 32:
                    _fail('Skill bundle nesting exceeds its limit.')
                before = os.fstat(directory)
                _directory(before)
                names = sorted(os.listdir(directory))
                for name in names:
                    entries += 1
                    if entries > MAX_BUNDLE_ENTRIES or '/' in name or name in {'.', '..'}:
                        _fail('Skill bundle entry count exceeds its limit.')
                    relative = prefix + name
                    info = _entry(directory, name)
                    if info is None:
                        _fail('Skill bundle changed during inspection.')
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        try:
                            if _signature(info) != _signature(os.fstat(child)):
                                _fail('Skill directory changed during inspection.')
                            manifest.append({'path': relative, 'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)})
                            visit(child, relative + '/', depth + 1)
                            linked = _entry(directory, name)
                            if linked is None or _signature(linked) != _signature(os.fstat(child)):
                                _fail('Skill directory changed during inspection.')
                        finally:
                            os.close(child)
                    else:
                        data, opened = _read_file(directory, name, MAX_FILE_BYTES)
                        total += len(data)
                        if total > MAX_BUNDLE_BYTES:
                            _fail('Skill bundle bytes exceed their limit.')
                        manifest.append({'path': relative, 'kind': 'file', 'mode': stat.S_IMODE(opened.st_mode), 'size': len(data), 'sha256': _hash(data)})
                        if relative == 'SKILL.md':
                            main = data
                if names != sorted(os.listdir(directory)) or _signature(before) != _signature(os.fstat(directory)):
                    _fail('Skill bundle changed during inspection.')

            visit(root)
            if main is None:
                _fail('Skill bundle is missing SKILL.md.')
            main.decode('utf-8')
            check = _open_directory(path)
            try:
                if _signature(first) != _signature(os.fstat(root)) or _identity(first) != _identity(os.fstat(check)):
                    _fail('Skill bundle directory was replaced.')
            finally:
                os.close(check)
            manifest.sort(key=lambda row: row['path'])
            return {'revision': _hash(main), 'bundleRevision': _hash(_encoded({'rootMode': stat.S_IMODE(first.st_mode), 'entries': manifest})),
                    'directoryIdentity': _identity(first), 'files': manifest}
        finally:
            os.close(root)
    except (OSError, UnicodeError):
        raise ValueError('Skill bundle cannot be safely read.') from None


def _name(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        _fail('Skill name must be a native lowercase slug.')
    return value


def _operation(value):
    if not isinstance(value, str) or not _OPERATION.fullmatch(value):
        _fail('Skill operation identity is invalid.')
    return value


def _creation(value):
    if not isinstance(value, str):
        _fail('Skill creation identity is invalid.')
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value or parsed.version != 4:
            _fail('Skill creation identity is invalid.')
    except (ValueError, AttributeError):
        _fail('Skill creation identity is invalid.')
    return value


def _revision(value):
    if not isinstance(value, str) or not _REVISION.fullmatch(value):
        _fail('Skill content revision is invalid.')
    return value


def _owned(info, *, directory=False):
    if directory:
        _directory(info)
    else:
        _regular(info, MAX_LEDGER_BYTES)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600):
        _fail('Private Skill provenance permissions cannot be verified.')


def _rename_noreplace(source, name, archive, archived_name):
    library = ctypes.CDLL(None, use_errno=True)
    function = getattr(library, 'renameatx_np' if sys.platform == 'darwin' else 'renameat2' if sys.platform.startswith('linux') else '', None)
    if function is None:
        _fail('Exclusive Skill archival is unavailable on this platform.')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    flag = 4 if sys.platform == 'darwin' else 1
    if function(source, os.fsencode(name), archive, os.fsencode(archived_name), flag) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


class SkillProvenance:
    def __init__(self, skills_root: Path, *, builtin_guard):
        if not callable(builtin_guard):
            _fail('A protected native Skill classifier is required.')
        try:
            self.root = _path(skills_root)
            root = _open_directory(self.root)
            try:
                self.root_identity = _identity(os.fstat(root))
            finally:
                os.close(root)
        except OSError:
            raise ValueError('Skill root cannot be safely opened.') from None
        self.ledger = self.root.parent / '.nodeorchard-skill-provenance'
        self.builtin_guard = builtin_guard

    def _root(self):
        root = _open_directory(self.root)
        if _identity(os.fstat(root)) != self.root_identity:
            os.close(root)
            _fail('Skill root was replaced.')
        return root

    def _protected(self, name, target, bundle):
        try:
            protected = self.builtin_guard(name, target, copy.deepcopy(bundle))
        except Exception:
            _fail('Native Skill protection could not be confirmed.')
        if protected is not False:
            _fail('Protected native Skills cannot be claimed or deleted.')

    def _subdirectory(self, parent, name, create, *, private=True):
        info = _entry(parent, name)
        if info is None:
            if not create:
                raise FileNotFoundError(name)
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
            else:
                os.fsync(parent)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if private:
                _owned(os.fstat(fd), directory=True)
            else:
                _directory(os.fstat(fd))
            linked = _entry(parent, name)
            if linked is None or _identity(linked) != _identity(os.fstat(fd)):
                _fail('Skill storage directory changed while opening it.')
            return fd
        except BaseException:
            os.close(fd)
            raise

    @contextmanager
    def _locked(self, *, create=False):
        if fcntl is None:
            _fail('Cross-process Skill provenance locking is unavailable.')
        parent = _open_directory(self.root.parent)
        ledger = lock = None
        try:
            ledger = self._subdirectory(parent, self.ledger.name, create)
            if create:
                try:
                    lock = os.open('lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=ledger)
                    os.fsync(ledger)
                except FileExistsError:
                    lock = os.open('lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=ledger)
            else:
                lock = os.open('lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=ledger)
            _owned(os.fstat(lock))
            linked = _entry(ledger, 'lock')
            if linked is None or _identity(linked) != _identity(os.fstat(lock)):
                _fail('Skill provenance lock was replaced.')
            fcntl.flock(lock, fcntl.LOCK_EX)
            if _identity(_entry(ledger, 'lock')) != _identity(os.fstat(lock)) or _identity(_entry(parent, self.ledger.name)) != _identity(os.fstat(ledger)):
                _fail('Skill provenance lock or directory was replaced.')
            root = self._root()
            try:
                yield ledger, root
            finally:
                os.close(root)
        finally:
            if lock is not None:
                os.close(lock)
            if ledger is not None:
                os.close(ledger)
            os.close(parent)

    def _read(self, parent, name):
        if _entry(parent, name) is None:
            return None
        data, info = _read_file(parent, name, MAX_LEDGER_BYTES)
        _owned(info)
        value = json.loads(data)
        if type(value) is not dict or value.get('format') != _FORMAT or value.get('version') != 1:
            _fail('Skill provenance record format is invalid.')
        return value

    def _write(self, parent, name, value):
        existing = _entry(parent, name)
        if existing is not None:
            _owned(existing)
        data = _encoded(value)
        if len(data) > MAX_LEDGER_BYTES:
            _fail('Skill provenance record exceeds its limit.')
        temporary = 'temporary-' + str(uuid.uuid4())
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                for offset in range(0, len(data), 64 * 1024):
                    view = memoryview(data)[offset:offset + 64 * 1024]
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            _fail('Skill provenance write did not progress.')
                        view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass

    def _record(self, ledger, creation_id):
        directory = self._subdirectory(ledger, 'records', False)
        try:
            value = self._read(directory, _creation(creation_id) + '.json')
            if value is not None:
                if value.get('creationId') != creation_id or value.get('state') not in {'active', 'deleting', 'tombstone'}:
                    _fail('Skill creation record identity is invalid.')
                _name(value.get('name')); _operation(value.get('createOperationId'))
                _revision(value.get('revision')); _revision(value.get('bundleRevision'))
                for key in ('rootIdentity', 'directoryIdentity'):
                    identity = value.get(key)
                    if type(identity) is not dict or set(identity) != {'dev', 'ino'} or any(type(number) is not int or number < 0 for number in identity.values()):
                        _fail('Skill creation directory identity is invalid.')
            return value
        finally:
            os.close(directory)

    def _write_record(self, ledger, record):
        directory = self._subdirectory(ledger, 'records', True)
        try:
            self._write(directory, _creation(record['creationId']) + '.json', record)
        finally:
            os.close(directory)

    def _index(self, ledger, name):
        directory = self._subdirectory(ledger, 'names', False)
        try:
            value = self._read(directory, hashlib.sha256(name.encode()).hexdigest() + '.json')
            if value is not None:
                if set(value) != {'format', 'version', 'name', 'creationId'} or value.get('name') != name:
                    _fail('Skill creation index identity is invalid.')
                _creation(value.get('creationId'))
            return value
        finally:
            os.close(directory)

    def _write_index(self, ledger, name, creation_id):
        directory = self._subdirectory(ledger, 'names', True)
        try:
            self._write(directory, hashlib.sha256(name.encode()).hexdigest() + '.json', {'format': _FORMAT, 'version': 1, 'name': name, 'creationId': creation_id})
        finally:
            os.close(directory)

    def _journal(self, ledger, operation_id):
        directory = self._subdirectory(ledger, 'operations', False)
        try:
            value = self._read(directory, hashlib.sha256(operation_id.encode()).hexdigest() + '.json')
            if value is not None:
                if value.get('operationId') != operation_id or value.get('kind') not in {'create', 'delete'} or value.get('status') not in {'pending', 'complete'}:
                    _fail('Skill operation journal identity is invalid.')
                _revision(value.get('fingerprint'))
            return value
        finally:
            os.close(directory)

    def _write_journal(self, ledger, journal):
        directory = self._subdirectory(ledger, 'operations', True)
        try:
            self._write(directory, hashlib.sha256(journal['operationId'].encode()).hexdigest() + '.json', journal)
        finally:
            os.close(directory)

    def _optional(self, read, *args):
        try:
            return read(*args)
        except FileNotFoundError:
            return None

    def _matches(self, record, name, bundle):
        return record and record.get('name') == name and record.get('rootIdentity') == self.root_identity and all(
            record.get(key) == bundle.get(key) for key in ('directoryIdentity', 'revision', 'bundleRevision'))

    def _metadata(self, record):
        return {'creationId': record['creationId'], 'revision': record['revision'], 'bundleRevision': record['bundleRevision'],
                'origin': {'kind': 'generated', 'label': '生成', 'canDelete': True}}

    def record_create(self, name, operation_id):
        name, operation_id = _name(name), _operation(operation_id)
        request = {'kind': 'create', 'name': name, 'operationId': operation_id}
        fingerprint = _hash(_encoded(request))
        try:
            with self._locked(create=True) as (ledger, _root):
                bundle = read_skill_bundle(self.root / name)
                self._protected(name, self.root / name, bundle)
                journal = self._optional(self._journal, ledger, operation_id)
                if journal and (journal.get('kind') != 'create' or journal.get('fingerprint') != fingerprint):
                    _fail('Skill operation identity was already used for different content.')
                index = self._optional(self._index, ledger, name)
                creation_id = str(uuid.UUID(bytes=hashlib.sha256(_encoded({'name': name, 'operationId': operation_id, 'rootIdentity': self.root_identity})).digest()[:16], version=4))
                record = self._record(ledger, index['creationId']) if index else self._optional(self._record, ledger, creation_id)
                if record and record.get('createOperationId') == operation_id and record.get('state') == 'active' and self._matches(record, name, bundle):
                    receipt = self._metadata(record)
                    if journal and journal.get('status') == 'complete':
                        if journal.get('receipt') != receipt:
                            _fail('Skill creation receipt is invalid.')
                        return receipt
                else:
                    if journal or record and record.get('state') != 'tombstone':
                        _fail('Skill creation is already recorded, changed or unconfirmed.')
                    record = {'format': _FORMAT, 'version': 1, 'state': 'active', 'name': name, 'creationId': creation_id,
                              'createOperationId': operation_id, 'rootIdentity': self.root_identity,
                              **{key: bundle[key] for key in ('directoryIdentity', 'revision', 'bundleRevision')}}
                    self._write_record(ledger, record)
                    receipt = self._metadata(record)
                self._write_journal(ledger, {'format': _FORMAT, 'version': 1, 'kind': 'create', 'status': 'pending',
                                           'operationId': operation_id, 'fingerprint': fingerprint, 'creationId': record['creationId']})
                self._write_index(ledger, name, record['creationId'])
                self._write_journal(ledger, {'format': _FORMAT, 'version': 1, 'kind': 'create', 'status': 'complete',
                                           'operationId': operation_id, 'fingerprint': fingerprint, 'receipt': receipt})
                return receipt
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError):
            raise ValueError('Skill creation provenance could not be safely recorded.') from None

    def inspect_owned(self, name, path, bundle):
        try:
            name = _name(name)
            if Path(path) != self.root / name or not self.ledger.exists():
                return None
            with self._locked() as (ledger, _root):
                index = self._optional(self._index, ledger, name)
                if not index:
                    return None
                record = self._record(ledger, index['creationId'])
                current = read_skill_bundle(self.root / name)
                if type(bundle) is not dict or any(bundle.get(key) != current[key] for key in ('directoryIdentity', 'revision', 'bundleRevision')):
                    return None
                self._protected(name, self.root / name, current)
                if record and record.get('state') == 'active' and self._matches(record, name, current):
                    return self._metadata(record)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError):
            return None
        return None

    def _receipt(self, record, operation_id):
        return {'name': record['name'], 'creationId': record['creationId'], 'revision': record['revision'],
                'bundleRevision': record['bundleRevision'], 'operationId': operation_id, 'deleted': True, 'archived': True}

    def _recover(self, ledger, record, request, fingerprint, journal):
        if record.get('pendingOperationId') != request['operation_id'] or record.get('pendingFingerprint') != fingerprint:
            _fail('Skill archival result is unknown; it cannot be replayed.')
        archive_name = record.get('archiveName')
        if archive_name != 'nodeorchard-' + hashlib.sha256(request['operation_id'].encode()).hexdigest():
            _fail('Skill archival identity could not be verified.')
        archived = read_skill_bundle(self.root / '.archive' / archive_name)
        if not self._matches(record, request['name'], archived):
            _fail('Skill archival result is unknown; it cannot be replayed.')
        receipt = self._receipt(record, request['operation_id'])
        record = {**record, 'state': 'tombstone'}
        self._write_record(ledger, record)
        self._write_journal(ledger, {**(journal or {}), 'format': _FORMAT, 'version': 1, 'kind': 'delete', 'status': 'complete',
                                    'operationId': request['operation_id'], 'fingerprint': fingerprint, 'receipt': receipt})
        return receipt

    def delete(self, params):
        fields = {'name', 'creation_id', 'expected_revision', 'expected_bundle_revision', 'operation_id'}
        if type(params) is not dict or set(params) != fields:
            _fail('Skill deletion requires exact creation and revision identities.')
        request = dict(params)
        name, operation_id = _name(request['name']), _operation(request['operation_id'])
        creation_id = _creation(request['creation_id'])
        _revision(request['expected_revision']); _revision(request['expected_bundle_revision'])
        fingerprint = _hash(_encoded(request))
        try:
            with self._locked() as (ledger, root):
                journal = self._optional(self._journal, ledger, operation_id)
                if journal:
                    if journal.get('kind') != 'delete' or journal.get('fingerprint') != fingerprint:
                        _fail('Skill operation identity was already used for different content.')
                    if journal.get('status') == 'complete':
                        receipt = {'name': name, 'creationId': creation_id, 'revision': request['expected_revision'], 'bundleRevision': request['expected_bundle_revision'],
                                   'operationId': operation_id, 'deleted': True, 'archived': True}
                        if journal.get('receipt') != receipt:
                            _fail('Skill archival receipt is invalid.')
                        return receipt
                index = self._optional(self._index, ledger, name)
                record = self._optional(self._record, ledger, creation_id)
                if not index or index.get('creationId') != creation_id or not record or record.get('name') != name or record.get('rootIdentity') != self.root_identity:
                    _fail('Skill has no matching generated creation record.')
                if record.get('revision') != request['expected_revision'] or record.get('bundleRevision') != request['expected_bundle_revision']:
                    _fail('Skill deletion revisions do not match its creation record.')
                if journal or record.get('state') != 'active':
                    return self._recover(ledger, record, request, fingerprint, journal)
                bundle = read_skill_bundle(self.root / name)
                if not self._matches(record, name, bundle):
                    _fail('Skill directory or complete bundle changed since its creation.')
                self._protected(name, self.root / name, bundle)
                archive = self._subdirectory(root, '.archive', True, private=False)
                try:
                    archive_name = 'nodeorchard-' + hashlib.sha256(operation_id.encode()).hexdigest()
                    if _entry(archive, archive_name) is not None:
                        _fail('Skill archive destination already exists; nothing was replaced.')
                    record = {**record, 'state': 'deleting', 'pendingOperationId': operation_id, 'pendingFingerprint': fingerprint, 'archiveName': archive_name}
                    self._write_record(ledger, record)
                    journal = {'format': _FORMAT, 'version': 1, 'kind': 'delete', 'status': 'pending', 'operationId': operation_id, 'fingerprint': fingerprint}
                    self._write_journal(ledger, journal)
                    current = read_skill_bundle(self.root / name)
                    self._protected(name, self.root / name, current)
                    final = read_skill_bundle(self.root / name)
                    if not self._matches(record, name, current) or not self._matches(record, name, final) or _identity(os.fstat(root)) != self.root_identity:
                        _fail('Skill changed before archival; the operation will not be replayed.')
                    check = self._root()
                    os.close(check)
                    if _identity(_entry(root, '.archive')) != _identity(os.fstat(archive)) or _identity(_entry(root, name)) != final['directoryIdentity']:
                        _fail('Skill archival directories changed; the operation will not be replayed.')
                    _rename_noreplace(root, name, archive, archive_name)
                    os.fsync(root); os.fsync(archive)
                finally:
                    os.close(archive)
                return self._recover(ledger, record, request, fingerprint, journal)
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError):
            raise ValueError('Skill archival result is unconfirmed; no automatic replay is permitted.') from None
