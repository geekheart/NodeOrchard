"""Bounded native capability discovery and application-owned integration mutations.

No credentials/configuration objects cross this module's result boundary. Native
providers own authentication and execution; the application owns artifact copies.
"""
from __future__ import annotations
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import stat
import uuid

from skill_provenance import SkillProvenance, read_skill_bundle

LABELS = {'image_gen': '图片生成', 'browser': '浏览器', 'computer_use': '桌面操作'}
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_IMAGES = 16
MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024


def external_tool(name):
    return isinstance(name, str) and (name in {'image_generate', 'computer_use', 'browser_exec', 'manage_connections'} or name.startswith(('browser_', 'mcp__')))


def validate_toolsets(value):
    if not isinstance(value, list) or len(value) > 16 or any(
            not isinstance(name, str) or not re.fullmatch(r'(?:image_gen|browser|computer_use|mcp-[A-Za-z0-9_.-]{1,96})', name) for name in value) or len(set(value)) != len(value):
        raise ValueError('required_toolsets must contain unique explicit integration toolset IDs.')
    return sorted(value)


def _real_parents(path, root):
    if not root.is_absolute() or root.resolve() != root or not path.is_absolute() or '..' in path.parts or not (path == root or root in path.parents):
        raise ValueError('Image path is outside its controlled directory.')
    current = root
    for part in (None, *path.relative_to(root).parts):
        current = current if part is None else current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('Image paths cannot contain symlinks.')
    return current


def _check_native_provenance_files(root):
    # Native readers deliberately fall back to empty sets on I/O/parse errors.
    # A deletion gate must distinguish that fallback from absent metadata.
    for relative in ('.bundled_manifest', '.curator_suppressed', '.hub/lock.json'):
        path = root / relative
        if '/' in relative and path.parent.is_symlink():
            raise ValueError('Native Skill provenance metadata is unsafe.')
        if not path.exists() and not path.is_symlink():
            continue
        _real_parents(path, root)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 512 * 1024:
            raise ValueError('Native Skill provenance metadata is unsafe.')
        with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)), 'rb') as stream:
            opened = os.fstat(stream.fileno()); data = stream.read(512 * 1024 + 1); after = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or len(data) > 512 * 1024 or (opened.st_mtime_ns, opened.st_size) != (after.st_mtime_ns, after.st_size):
            raise ValueError('Native Skill provenance metadata changed while reading it.')
        text = data.decode('utf-8-sig')
        if '\0' in text:
            raise ValueError('Native Skill provenance metadata is invalid.')
        if relative.endswith('.json'):
            value = json.loads(text)
            if not isinstance(value, dict) or not isinstance(value.get('installed', {}), dict):
                raise ValueError('Native Skill provenance metadata is invalid.')


def _read_image(path, root):
    _real_parents(path, root)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= MAX_IMAGE_BYTES:
        raise ValueError('Generated image must be a bounded ordinary file.')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise ValueError('Generated image changed while opening it.')
        data = stream.read(MAX_IMAGE_BYTES + 1)
        after = os.fstat(stream.fileno())
    if len(data) > MAX_IMAGE_BYTES or (opened.st_mtime_ns, opened.st_size) != (after.st_mtime_ns, after.st_size):
        raise ValueError('Generated image changed while reading it.')
    _real_parents(path, root)
    if (data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR'
            and int.from_bytes(data[16:20], 'big') > 0 and int.from_bytes(data[20:24], 'big') > 0):
        mime, extension = 'image/png', 'png'
    elif data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'):
        mime, extension = 'image/jpeg', 'jpg'
    elif data.startswith((b'GIF87a', b'GIF89a')) and len(data) >= 13 and int.from_bytes(data[6:8], 'little') > 0 and int.from_bytes(data[8:10], 'little') > 0:
        mime, extension = 'image/gif', 'gif'
    elif data.startswith(b'RIFF') and len(data) >= 20 and data[8:12] == b'WEBP' and int.from_bytes(data[4:8], 'little') + 8 == len(data):
        mime, extension = 'image/webp', 'webp'
    else:
        raise ValueError('Generated image has unsupported image bytes.')
    return data, mime, extension


class WorkflowIntegrations:
    def __init__(self, model_tools, *, dependencies=None):
        self.model_tools = model_tools
        self.dependencies = dependencies or {}

    def _native(self, name):
        if name in self.dependencies:
            return self.dependencies[name]
        if name in {'load_config', 'save_config'}:
            from hermes_cli import config
            return getattr(config, 'load_config_readonly', config.load_config) if name == 'load_config' else config.save_config
        if name == 'config_lock':
            from hermes_cli.config import _CONFIG_LOCK
            return _CONFIG_LOCK
        if name == 'enabled_toolsets':
            from hermes_cli.tools_config import _get_platform_tools
            return lambda cfg: _get_platform_tools(cfg, 'cli', include_default_mcp_servers=True)
        if name == 'providers':
            from hermes_cli.plugins import _ensure_plugins_discovered
            from agent.image_gen_registry import list_providers
            def providers():
                _ensure_plugins_discovered()
                return list_providers()
            return providers
        if name in {'cache_root', 'skills_root'}:
            from hermes_constants import get_hermes_home
            return lambda: get_hermes_home() / ('cache/images' if name == 'cache_root' else 'skills')
        if name == 'create_skill':
            from tools.skill_manager_tool import _create_skill
            return _create_skill
        if name == 'resolve_skill_dir':
            from tools.skill_manager_tool import _resolve_skill_dir
            return _resolve_skill_dir
        if name == 'skill_lock':
            from tools.skill_manager_tool import _skill_mutation_lock
            return _skill_mutation_lock
        if name == 'skill_entries':
            from agent.skill_commands import scan_skill_commands
            from tools.skills_tool import _find_all_skills
            def entries():
                commands = list(scan_skill_commands().values())
                result = []
                for row in _find_all_skills():
                    matches = [item for item in commands if item.get('name') == row.get('name')]
                    result.append(dict(row, path=matches[0].get('skill_dir') if len(matches) == 1 else None))
                return result
            return entries
        if name == 'skill_sources':
            from tools.skill_usage import _read_bundled_names, _read_hub_installed_names, PROTECTED_BUILTIN_SKILLS
            from agent.skill_utils import ESSENTIAL_SKILLS
            def sources():
                _check_native_provenance_files(Path(self._native('skills_root')()))
                return {'bundled': _read_bundled_names(), 'hub': _read_hub_installed_names(),
                        'protected': set(PROTECTED_BUILTIN_SKILLS) | set(ESSENTIAL_SKILLS)}
            return sources
        if name == 'workbench_skills_root':
            return lambda: Path(__file__).resolve().parents[1] / 'skills'
        raise ValueError('Unsupported native integration interface.')

    def _skill_protection(self):
        sources = self._native('skill_sources')()
        if not isinstance(sources, dict) or any(not isinstance(sources.get(key), (set, list, tuple))
                or any(not isinstance(value, str) for value in sources[key]) for key in ('bundled', 'hub')):
            raise ValueError('Native Skill provenance is unavailable.')
        protected = sources.get('protected', ())
        if not isinstance(protected, (set, list, tuple, frozenset)) or any(not isinstance(value, str) for value in protected):
            raise ValueError('Native Skill protected names are unavailable.')
        templates = set()
        root = Path(self._native('workbench_skills_root')())
        if root.is_symlink() or not root.is_dir() or root.resolve() != root:
            raise ValueError('Workbench Skill source directory is unavailable.')
        for path in sorted(root.iterdir()):
            if not path.is_dir() or path.is_symlink():
                continue
            if (path/'SKILL.md').is_file():
                templates.add(read_skill_bundle(path)['bundleRevision'])
        return {'bundled': set(sources['bundled']), 'hub': set(sources['hub']), 'templates': templates, 'protected': set(protected)}

    def _builtin_origin(self, name, path, bundle, protection):
        root = Path(self._native('skills_root')())
        if bundle and bundle['bundleRevision'] in protection['templates']:
            return {'kind': 'workbench-builtin', 'label': '工作台内置', 'canDelete': False}
        # A same-named project/external Skill is not the manifest's installed
        # package. Keep it read-only without inventing native builtin provenance.
        if name in protection['bundled'] and path and root.resolve() == root and path.resolve() == path and root in path.parents:
            return {'kind': 'hermes-builtin', 'label': 'Hermes 内置', 'canDelete': False}
        return None

    def _provenance(self):
        def protected(name, path, bundle):
            protection = self._skill_protection()
            return bool(self._builtin_origin(name, path, bundle, protection)) or name in protection['bundled'] or name in protection['hub'] or name in protection['protected']
        return SkillProvenance(Path(self._native('skills_root')()), builtin_guard=protected)

    def skills_catalog(self):
        protection = self._skill_protection()
        entries = self._native('skill_entries')()
        if not isinstance(entries, list) or len(entries) > 5000:
            raise ValueError('Native Skill directory is unavailable.')
        repo, result, seen = self._provenance(), [], set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError('Native Skill entry is invalid.')
            name = entry.get('name')
            if not isinstance(name, str) or not name or len(name) > 256 or any(ord(c) < 32 or ord(c) == 127 for c in name) or name in seen:
                continue
            seen.add(name)
            source = 'hub' if name in protection['hub'] else 'bundled' if name in protection['bundled'] else 'local'
            description = entry.get('description') if isinstance(entry.get('description'), str) else ''
            category = entry.get('category') if isinstance(entry.get('category'), str) and entry['category'] else 'general'
            row = {'name': name, 'description': description[:2000], 'category': category[:120],
                   'enabled': entry.get('enabled', True) is True, 'source': source,
                   'origin': {'kind': 'unknown', 'label': '其他已安装', 'canDelete': False, 'reason': '此 Skill 没有本版本的生成回执。'}}
            try:
                path = Path(entry['path']) if isinstance(entry.get('path'), str) else None
                bundle = read_skill_bundle(path) if path and path.is_absolute() else None
                origin = self._builtin_origin(name, path, bundle, protection)
                if origin:
                    row['origin'] = origin
                elif bundle:
                    owned = repo.inspect_owned(name, path, bundle)
                    if owned:
                        row.update(owned)
                if bundle:
                    row['revision'], row['bundleRevision'] = bundle['revision'], bundle['bundleRevision']
            except (OSError, ValueError, TypeError):
                row['origin'] = {'kind': 'unknown', 'label': '其他已安装', 'canDelete': False, 'reason': '当前包身份或来源无法安全确认。'}
            result.append(row)
        return {'skills': sorted(result, key=lambda row: row['name'])}

    def delete_skill(self, params):
        if not isinstance(params, dict) or not isinstance(params.get('name'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', params['name']):
            raise ValueError('A generated Skill name is required.')
        with self._native('skill_lock')(params['name']):
            return self._provenance().delete(params)

    def catalog(self):
        try:
            cfg = self._native('load_config')()
            if not isinstance(cfg, dict): raise ValueError()
            enabled = set(self._native('enabled_toolsets')(cfg))
            disabled = (cfg.get('agent') or {}).get('disabled_toolsets') or []
        except Exception:
            cfg, enabled, disabled = {}, set(), []
        image_config = cfg.get('image_gen') or {}
        selected = image_config.get('provider') if isinstance(image_config, dict) else None
        selected = selected if isinstance(selected, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', selected) else ''
        configured = cfg.get('mcp_servers') or {}
        configured = configured if isinstance(configured, dict) else {}
        ids = list(LABELS) + sorted('mcp-' + name for name, row in configured.items() if isinstance(name, str)
            and re.fullmatch(r'[A-Za-z0-9_.-]{1,96}', name) and isinstance(row, dict))
        rows, schemas = [], []
        for name in ids:
            try:
                fn = getattr(self.model_tools, 'get_tool_definitions')
                if not {'enabled_toolsets', 'disabled_toolsets', 'quiet_mode', 'skip_tool_search_assembly'} <= set(inspect.signature(fn).parameters) and not any(p.kind == p.VAR_KEYWORD for p in inspect.signature(fn).parameters.values()):
                    raise ValueError()
                definitions = fn(enabled_toolsets=[name], disabled_toolsets=disabled, quiet_mode=True, skip_tool_search_assembly=True)
                names = sorted({row['function']['name'] for row in definitions if isinstance(row, dict) and isinstance(row.get('function'), dict)
                    and isinstance(row['function'].get('name'), str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', row['function']['name'])})
                available = bool(names)
                if name == 'browser': available = bool({'browser_navigate', 'browser_exec'} & set(names))
                schemas.append([name, sorted(({'name': row['function']['name'], 'parameters': row['function'].get('parameters', {})}
                    for row in definitions if row.get('function', {}).get('name') in names), key=lambda row: row['name'])])
                reason = '' if available else '尚未就绪：请在 Hermes 配置此工具及其依赖、认证。'
            except Exception:
                names, available, reason = [], False, 'Hermes 原生工具目录不可用或版本不兼容。'
            active = (name in enabled or name.startswith('mcp-') and name[4:] in enabled) and name not in disabled
            if name.startswith('mcp-') and configured[name[4:]].get('enabled', True) is not True:
                active = False
            rows.append({'id': name, 'label': LABELS.get(name, name[4:]), 'available': available, 'enabled': active,
                         'tools': names, 'reason': reason if not available else '' if active else '此工具集尚未在 Hermes 启用。'})
        providers = []
        try:
            for provider in self._native('providers')()[:32]:
                name = getattr(provider, 'name', None)
                if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', name): continue
                try: available = bool(provider.is_available())
                except Exception: available = False
                # Labels are fixed identities, never arbitrary provider exception/config text.
                label = {'openai-codex': 'ChatGPT / Codex', 'openai': 'OpenAI API', 'fal': 'FAL.ai', 'nous': 'Nous Subscription'}.get(name, name)
                providers.append({'id': name, 'label': label, 'available': available,
                                  'reason': '' if available else '尚未配置此图片提供商的认证或依赖。'})
        except Exception: pass
        scoped_model = image_config.get(selected) if isinstance(image_config, dict) else None
        models = [image_config.get('model'), scoped_model.get('model') if isinstance(scoped_model, dict) else None] if isinstance(image_config, dict) else []
        models = [model if isinstance(model, str) and len(model) <= 256 else None for model in models]
        revision = 'sha256:' + hashlib.sha256(json.dumps({'provider': selected, 'imageModels': models, 'toolsets': rows, 'schemas': schemas},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return {'toolsets': rows, 'imageProviders': providers, 'selectedImageProvider': selected, 'revision': revision}

    def required(self, required, expected_revision=None):
        ids = validate_toolsets(required)
        if not ids: return [], []
        catalog = self.catalog()
        if expected_revision is not None and catalog['revision'] != expected_revision:
            raise ValueError('Native capability revision changed; prepare a new attempt.')
        rows = {row['id']: row for row in catalog['toolsets']}
        names = set()
        for name in ids:
            row = rows.get(name)
            if not row or not row['available'] or not row['enabled']:
                raise ValueError('Required toolset is unavailable or disabled: ' + name)
            names.update(row['tools'])
        return ids, sorted(names)

    def definitions(self, required, names):
        try:
            definitions = self.model_tools.get_tool_definitions(enabled_toolsets=required, disabled_toolsets=None,
                quiet_mode=True, skip_tool_search_assembly=True)
        except Exception as error:
            raise ValueError('Native tool definitions are unavailable or incompatible.') from error
        selected = [row for row in definitions if row.get('function', {}).get('name') in names]
        if {row['function']['name'] for row in selected} != set(names):
            raise ValueError('Required native tools changed after capability admission.')
        return copy.deepcopy(selected)

    def import_image(self, run, result):
        if not isinstance(run.get('run_id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', run['run_id']):
            raise ValueError('Image artifact attempt identity is invalid.')
        try: payload = json.loads(result) if isinstance(result, str) else result
        except (ValueError, TypeError): return None
        if not isinstance(payload, dict) or payload.get('success') is not True: return None
        source = payload.get('image')
        if not isinstance(source, str) or not Path(source).is_absolute():
            raise ValueError('Native image generation did not return an absolute cached image path.')
        root, path = Path(self._native('cache_root')()), Path(source)
        data, mime, extension = _read_image(path, root)
        digest = hashlib.sha256(data).hexdigest()
        artifacts = run.setdefault('artifacts', [])
        if any(row['sourcePath'] == source and row['sha256'] == digest for row in artifacts): return None
        if len(artifacts) >= MAX_IMAGES or run.get('artifact_bytes', 0) + len(data) > MAX_TOTAL_IMAGE_BYTES:
            raise ValueError('Generated image artifacts exceed the attempt limit.')
        workspace = Path(run['workspace'])
        parent = workspace / '.workbench-artifacts'
        for directory in (parent, parent / run['run_id']):
            if directory.is_symlink() or directory.exists() and not directory.is_dir():
                raise ValueError('Artifact destination must be an ordinary directory.')
            directory.mkdir(mode=0o700, exist_ok=True)
            _real_parents(directory, workspace)
        target = parent / run['run_id'] / (uuid.uuid4().hex + '.' + extension)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as stream: stream.write(data)
        _real_parents(target, workspace)
        artifact = {'path': str(target), 'sourcePath': source, 'sha256': digest, 'mimeType': mime, 'toolName': 'image_generate'}
        artifacts.append(artifact); run['artifact_bytes'] = run.get('artifact_bytes', 0) + len(data)
        return artifact

    def create_skill(self, params):
        if not isinstance(params, dict) or not isinstance(params.get('name'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', params['name']):
            raise ValueError('A new lowercase Skill slug is required.')
        with self._native('skill_lock')(params['name']):
            return self._create_skill_locked(params)

    def _create_skill_locked(self, params):
        if not isinstance(params, dict) or set(params) - {'name', 'description', 'instructions', 'required_toolsets', 'operation_id'}:
            raise ValueError('Unexpected Skill creation parameters.')
        name, description, instructions = (params.get(key) for key in ('name', 'description', 'instructions'))
        operation_id = params.get('operation_id')
        if not isinstance(operation_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', operation_id):
            raise ValueError('A Skill creation operation identity is required.')
        if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', name):
            raise ValueError('A new lowercase Skill slug is required.')
        if not isinstance(description, str) or not description.strip() or len(description.encode('utf-8')) > 2048 or '\0' in description:
            raise ValueError('A bounded Skill description is required.')
        if not isinstance(instructions, str) or not instructions.strip() or len(instructions.encode('utf-8')) > 128 * 1024 or '\0' in instructions:
            raise ValueError('Bounded Skill instructions are required.')
        required = validate_toolsets(params.get('required_toolsets', []))
        if not set(required) <= {row['id'] for row in self.catalog()['toolsets']}:
            raise ValueError('Skill dependency is not a registered integration toolset.')
        root = Path(self._native('skills_root')())
        target = Path(self._native('resolve_skill_dir')(name, None))
        if root.resolve() != root or target != root/name or target.exists() or target.is_symlink():
            raise ValueError('Skill target exists or is outside the native Skill root.')
        protection = self._skill_protection()
        if name in protection['bundled'] or name in protection['hub'] or name in protection['protected']:
            raise ValueError('A protected installed Skill name cannot become a generated Skill.')
        content = ('---\nname: ' + json.dumps(name) + '\ndescription: ' + json.dumps(description.strip(), ensure_ascii=False)
                   + '\nrequired-toolsets: ' + json.dumps(required) + '\n---\n\n' + instructions.strip() + '\n')
        result = self._native('create_skill')(name=name, content=content, category=None)
        if not isinstance(result, dict) or result.get('success') is not True:
            raise ValueError('Native Skill creation was rejected.')
        path = target/'SKILL.md'
        _real_parents(path, root)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 256 * 1024:
            raise ValueError('Created Skill is not a bounded regular file.')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(path, flags), 'rb') as stream:
            data = stream.read(256 * 1024 + 1)
        if data != content.encode('utf-8'):
            raise ValueError('Created Skill content did not match the submitted instructions.')
        ownership = self._provenance().record_create(name, operation_id)
        return {'created': True, 'skill': {'name': name, 'description': description.strip(), 'content': content,
                'revision': 'sha256:' + hashlib.sha256(data).hexdigest(), 'requiredToolsets': required, **ownership}}

    def image_provider(self, params):
        if not isinstance(params, dict) or set(params) - {'provider', 'expected_provider'} or ('expected_provider' in params and 'provider' not in params):
            raise ValueError('Unexpected image provider parameters.')
        before = self.catalog()
        if 'provider' not in params:
            return {'selectedImageProvider': before['selectedImageProvider'], 'imageProviders': before['imageProviders'], 'changed': False}
        provider = params['provider']
        if not isinstance(provider, str) or provider not in {row['id'] for row in before['imageProviders']}:
            raise ValueError('Image provider is not in the native provider registry.')
        expected = params.get('expected_provider', before['selectedImageProvider'])
        if not isinstance(expected, str): raise ValueError('Invalid expected provider.')
        with self._native('config_lock'):
            cfg = self._native('load_config')()
            section = cfg.get('image_gen') or {}
            if not isinstance(section, dict): raise ValueError('Invalid native image configuration.')
            current = section.get('provider') or ''
            if current != expected:
                raise ValueError('Image provider selection changed concurrently.')
            if provider != current:
                save = self._native('save_config')
                if 'merge_existing' not in inspect.signature(save).parameters and not any(p.kind == p.VAR_KEYWORD for p in inspect.signature(save).parameters.values()):
                    raise ValueError('Native image configuration cannot be safely partially saved.')
                save({'image_gen': {'provider': provider}}, merge_existing=True)
        after = self.catalog()
        if after['selectedImageProvider'] != provider:
            raise ValueError('Native image provider read-back did not confirm the selection.')
        return {'selectedImageProvider': provider, 'imageProviders': after['imageProviders'], 'changed': provider != current}
