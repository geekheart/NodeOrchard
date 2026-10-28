"""Instance-scoped, metadata-only HTTP observations for protected assistants.

No global client/transport patch, packet capture, URL, header map, body, reasoning,
exception message or provider configuration is emitted. Unknown stages stay null.
httpcore connect_tcp includes DNS/proxy work; it is not a separate DNS metric.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import functools
import inspect
import re
import threading
import time
import uuid
import weakref


SSE_TYPES = frozenset({
    'message', 'error', 'ping', 'done', 'response.created', 'response.in_progress',
    'response.queued', 'response.output_item.added', 'response.output_item.done',
    'response.content_part.added', 'response.content_part.done',
    'response.output_text.delta', 'response.output_text.done', 'response.completed',
    'response.failed', 'response.incomplete', 'response.refusal.delta', 'response.refusal.done',
    'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
    'response.reasoning_text.delta', 'response.reasoning_text.done',
    'message_start', 'message_delta', 'message_stop', 'content_block_start',
    'content_block_delta', 'content_block_stop',
})
ERROR_TYPES = frozenset({'TimeoutException', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout',
    'PoolTimeout', 'ConnectError', 'ReadError', 'WriteError', 'RemoteProtocolError',
    'LocalProtocolError', 'HTTPStatusError', 'CancelledError', 'SDKError',
    'TransportError', 'UnknownError'})
_UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
_REQUEST_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
_SECRET_REQUEST_ID = re.compile(r'(?:sk-|gh[pousr]_|github_pat_|eyJ|bearer)', re.IGNORECASE)
_FACTORIES = ('_create_openai_client', '_build_direct_anthropic_client', '_build_anthropic_client_for_key')
_TRANSPORT_PHASES = {'connection.connect_tcp': 'connectMs', 'connection.start_tls': 'tlsMs', 'proxy.start_tls': 'tlsMs'}
# Bound only the added observer's work. The SDK still owns decompression and the
# original chunks; this observer never allocates a second decompressed body.
MAX_SSE_OBSERVED_BYTES = 8 * 1024 * 1024


def _iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _error_type(error, *, sdk=False):
    names = [type(error).__name__] + [base.__name__ for base in type(error).__mro__[1:]]
    if any(name in {'CancelledError', 'KeyboardInterrupt'} for name in names):
        return 'CancelledError'
    return next((name for name in names if name in ERROR_TYPES), 'SDKError' if sdk else 'UnknownError')


def _response_format(value):
    mime = value.split(';', 1)[0].strip().lower() if isinstance(value, str) else ''
    if not mime: return 'unknown'
    if mime == 'text/event-stream': return 'event-stream'
    if mime == 'application/json' or re.fullmatch(r'application/[a-z0-9!#$&^_.+-]+\+json', mime): return 'json'
    return 'other'


class SSECounter:
    """Parse framing only. data: bytes are discarded without buffering payloads."""
    def __init__(self):
        self.events, self.other = {}, 0
        self.truncated = False
        self._prefix, self._event_value = bytearray(), bytearray()
        self._mode, self._event, self._data, self._line_seen = 'prefix', None, False, False

    def feed(self, chunk):
        start = 0
        while start < len(chunk):
            end = chunk.find(b'\n', start)
            stop = len(chunk) if end < 0 else end
            self._piece(memoryview(chunk)[start:stop])
            if end < 0:
                break
            self._end_line()
            start = end + 1

    def _piece(self, piece):
        index = 0
        while self._mode == 'prefix' and index < len(piece):
            byte = piece[index]; index += 1
            if byte == 13:  # CR in CRLF; no provider body needs retaining.
                continue
            self._line_seen = True
            self._prefix.append(byte)
            prefix = bytes(self._prefix)
            if prefix == b'data:':
                self._data = True; self._mode = 'ignore'; self._prefix.clear()
            elif prefix == b'event:':
                self._mode = 'event'; self._prefix.clear()
            elif not b'data:'.startswith(prefix) and not b'event:'.startswith(prefix):
                self._mode = 'ignore'; self._prefix.clear()
        if self._mode == 'event' and index < len(piece):
            room = max(0, 128 - len(self._event_value))
            self._event_value.extend(piece[index:index + room])
            if len(piece) - index > room:
                self._mode = 'oversized'; self._event_value.clear(); self.truncated = True

    def _end_line(self):
        if not self._line_seen:
            if self._data:
                event = self._event or 'message'
                if event in SSE_TYPES:
                    count = self.events.get(event, 0)
                    if count < 1_000_000: self.events[event] = count + 1
                    else: self.truncated = True
                elif self.other < 1_000_000: self.other += 1
                else: self.truncated = True
            self._event, self._data = None, False
        elif self._mode == 'event':
            event = bytes(self._event_value).strip(b' \r').decode('ascii', errors='replace')
            self._event = event if event in SSE_TYPES else '__other__'
        elif self._mode == 'oversized':
            self._event = '__other__'
        elif bytes(self._prefix) == b'data':
            self._data = True
        self._prefix.clear(); self._event_value.clear()
        self._mode, self._line_seen = 'prefix', False

    def snapshot(self):
        return {'events': dict(self.events), 'otherEvents': self.other, 'truncated': self.truncated}


class _Request:
    def __init__(self, owner, index):
        self.owner, self.index = owner, index
        self.request_id = owner.request_id
        self.id, self.started_at, self.start = str(uuid.uuid4()), _iso(), time.monotonic()
        self.status, self.code, self.done, self.body_complete = 'running', None, False, None
        self.timings = {key: None for key in ('connectMs', 'tlsMs', 'headersMs', 'firstBodyByteMs', 'lastBodyByteMs')}
        self.observable = {key: 'unavailable' for key in ('dns', 'connect', 'tls', 'headers', 'sse')}
        self.http = {'status': None, 'requestId': None, 'requestIdHeader': None, 'retryAfterSeconds': None,
                     'responseFormat': 'unknown', 'contentEncoding': None}
        self.error = {'source': None, 'type': None}
        self.counter, self.sse, self.phases = SSECounter(), False, {}
        self.sse_unavailable_reason = 'unknown'
        self.decoded_started, self.decoded_active, self.final_pending = False, False, False
        self.sse_bytes, self.sse_exhausted = 0, False
        self.emissions, self.last_emit = 0, 0.0
        self.lock = threading.RLock()

    def elapsed(self):
        return round(max(0, (time.monotonic() - self.start) * 1000), 3)

    def snapshot(self):
        with self.lock:
            return {'version': 1, 'traceId': self.id, 'requestId': self.request_id, 'requestIndex': self.index,
                'status': self.status, 'startedAt': self.started_at, 'updatedAt': _iso(), 'durationMs': self.elapsed(),
                'transport': 'httpx', 'observability': dict(self.observable), 'timings': dict(self.timings),
                'http': dict(self.http), 'sse': {**self.counter.snapshot(), 'unavailableReason': self.sse_unavailable_reason}, 'error': dict(self.error),
                'bodyComplete': self.body_complete, **({'code': self.code} if self.code else {})}

    def emit(self, *, final=False):
        with self.lock:
            now = time.monotonic()
            if not final and self.emissions >= 16: return
            self.emissions += 1; self.last_emit = now
            snapshot = self.snapshot()
        self.owner.emit(snapshot)

    def core(self, event):
        with self.lock:
            if self.done: return
            for phase, key in _TRANSPORT_PHASES.items():
                if event == phase + '.started': self.phases[phase] = time.monotonic()
                elif event == phase + '.complete' and phase in self.phases:
                    value = round(max(0, (time.monotonic() - self.phases.pop(phase)) * 1000), 3)
                    self.timings[key] = round((self.timings[key] or 0) + value, 3)
                    self.observable['connect' if key == 'connectMs' else 'tls'] = 'observed'

    def headers(self, response):
        with self.lock:
            if self.done: return
            self.timings['headersMs'] = self.elapsed(); self.observable['headers'] = 'observed'
            status = getattr(response, 'status_code', None)
            self.http['status'] = status if type(status) is int and 100 <= status <= 599 else None
            for key in ('x-request-id', 'request-id'):
                value = response.headers.get(key)
                if isinstance(value, str) and _REQUEST_ID.fullmatch(value) and not _SECRET_REQUEST_ID.match(value):
                    self.http['requestId'], self.http['requestIdHeader'] = value, key; break
            value = response.headers.get('retry-after')
            if isinstance(value, str) and re.fullmatch(r'[0-9]{1,9}', value):
                self.http['retryAfterSeconds'] = int(value)
            self.http['responseFormat'] = _response_format(response.headers.get('content-type'))
            encoding = response.headers.get('content-encoding', '').strip().lower() or 'identity'
            self.http['contentEncoding'] = encoding if encoding in {'identity', 'gzip', 'deflate', 'br', 'zstd'} else 'other'
            self.sse = self.http['responseFormat'] == 'event-stream'
            self.sse_unavailable_reason = ('decoded-stream-unobserved' if self.sse else
                                          'unknown' if self.http['responseFormat'] == 'unknown' else 'not-event-stream')
            if status is not None and status >= 400: self.error = {'source': 'http', 'type': 'HTTPStatusError'}
        self.emit()

    def body(self, chunk):
        with self.lock:
            if self.done or not chunk: return
            at = self.elapsed(); first = self.timings['firstBodyByteMs'] is None
            if first: self.timings['firstBodyByteMs'] = at
            self.timings['lastBodyByteMs'] = at
            publish = first or time.monotonic() - self.last_emit >= 5
        if publish: self.emit()

    def begin_decoded(self):
        with self.lock:
            # httpx caches completed content. A later iter_bytes/read must not
            # count the same server frames again or reset the observation quota.
            if self.decoded_started: return False
            self.decoded_started, self.decoded_active = True, True
            if self.sse:
                self.observable['sse'] = 'observed'
                self.sse_unavailable_reason = None
            return True

    def decoded_body(self, chunk):
        with self.lock:
            if not self.sse or self.sse_exhausted or self.done and not self.final_pending or not chunk: return
            first = self.sse_bytes == 0
            if len(chunk) > MAX_SSE_OBSERVED_BYTES - self.sse_bytes:
                # Do not scan, copy, buffer or decompress an oversized chunk.
                # Empty counters plus unavailable/truncated mean unknown, not zero.
                self.invalidate_sse('observation-limit')
                publish = True
            else:
                self.sse_bytes += len(chunk)
                self.counter.feed(chunk)
                publish = first or time.monotonic() - self.last_emit >= 5
            publish = publish and not self.final_pending
        if publish: self.emit()

    def invalidate_sse(self, reason='parser-error'):
        with self.lock:
            self.sse_exhausted = True
            self.counter = SSECounter(); self.counter.truncated = True
            self.observable['sse'] = 'unavailable'
            self.sse_unavailable_reason = reason

    def end_decoded(self, error=None):
        with self.lock:
            self.decoded_active = False
            if error is not None and (not self.done or self.final_pending):
                # Raw EOF can precede the SDK decoder's flush. Preserve its real
                # EOF fact while recording only a fixed decoder/SDK error type.
                if not self.done: self.body_complete = False
                kind = _error_type(error, sdk=True)
                self.error = {'source': 'cancelled' if kind == 'CancelledError' else 'sdk', 'type': kind}
                self.status = 'cancelled' if kind == 'CancelledError' else 'error'
                self.done, self.final_pending = True, True
            publish, self.final_pending = self.final_pending, False
        if publish: self.emit(final=True)

    def finish(self, error=None, *, complete=False):
        with self.lock:
            if self.done: return
            self.done = True; self.body_complete = complete
            if error is not None:
                kind = _error_type(error)
                self.error = {'source': 'cancelled' if kind == 'CancelledError' else 'transport', 'type': kind}
                self.status = 'cancelled' if kind == 'CancelledError' else 'error'
            else:
                self.status = 'error' if self.error['source'] == 'http' else 'complete'
            # iter_bytes flushes its existing decoder after iter_raw reaches EOF.
            # Defer that single terminal snapshot until the decoded tail is seen.
            self.final_pending = bool(complete and self.decoded_active and self.sse)
            publish = not self.final_pending
        if publish: self.emit(final=True)


class ModelRequestTracer:
    """Bind to one protected agent and its privately constructed sync SDK clients."""
    def __init__(self, emit, *, request_id=None):
        self._emit = emit
        self.request_id = request_id if isinstance(request_id, str) and _UUID.fullmatch(request_id) else None
        self.active, self.index, self.limit_reported = 0, 0, False
        self.unavailable_count = 0
        self.unavailable_record, self.unavailable_seen = None, set()
        self.lock = threading.RLock()
        self.requests = weakref.WeakKeyDictionary()

    def emit(self, snapshot):
        try: self._emit(snapshot)
        except Exception: pass  # Observations can never fail or retry an SDK call.

    def unavailable(self, code, *, error=None):
        kind = _error_type(error, sdk=True) if error is not None else None
        with self.lock:
            self.unavailable_count += 1
            key = (code, kind)
            if key in self.unavailable_seen or len(self.unavailable_seen) >= 16: return
            self.unavailable_seen.add(key)
            if self.unavailable_record is None: self.unavailable_record = _Request(self, 0)
            value = self.unavailable_record.snapshot()
        value.update(status='unavailable', transport='unavailable', code=code)
        if error is not None:
            value['error'] = {'source': 'cancelled' if kind == 'CancelledError' else 'sdk', 'type': kind}
        self.emit(value)

    def set_request_id(self, value):
        if value is not None and (not isinstance(value, str) or not _UUID.fullmatch(value)):
            raise ValueError('Model trace control identity is invalid.')
        with self.lock:
            if self.active: raise ValueError('Model trace is already active.')
            if value != self.request_id:
                self.request_id, self.index, self.limit_reported = value, 0, False
                self.unavailable_record, self.unavailable_seen = None, set()

    @contextmanager
    def turn(self):
        with self.lock: self.active += 1
        try: yield
        except BaseException as error:
            self.unavailable('TRACE_HOOK_UNAVAILABLE', error=error)
            raise
        finally:
            with self.lock: self.active -= 1

    def _request(self, request):
        # Never observe authentication, model catalogs, images, or other tools.
        if request.method != 'POST': return
        with self.lock:
            if not self.active: return
            if not request.url.path.rstrip('/').endswith(('/responses', '/chat/completions', '/messages')):
                self.unavailable('TRACE_TRANSPORT_UNAVAILABLE'); return
            if self.index >= 32:
                if not self.limit_reported:
                    self.limit_reported = True; self.unavailable('TRACE_REQUEST_LIMIT')
                return
            self.index += 1; record = _Request(self, self.index); self.requests[request] = record
        previous = request.extensions.get('trace')
        def trace(event, info):
            try: record.core(event)
            except Exception: pass
            if callable(previous): return previous(event, info)
        request.extensions['trace'] = trace
        record.emit()

    def attach_http_client(self, client):
        if client is None: return False
        try:
            import httpx
            if not isinstance(client, httpx.Client):
                self.unavailable('TRACE_TRANSPORT_UNAVAILABLE'); return False
            previous = getattr(client, '_workbench_model_request_tracer', None)
            if previous is self: return True
            if previous is not None:
                self.unavailable('TRACE_HOOK_UNAVAILABLE'); return False
            original = client.send
            if inspect.iscoroutinefunction(original):
                self.unavailable('TRACE_TRANSPORT_UNAVAILABLE'); return False
            def request_hook(request):
                try: self._request(request)
                except Exception: self.unavailable('TRACE_HOOK_UNAVAILABLE')
            def response_hook(response):
                try:
                    with self.lock: record = self.requests.get(response.request)
                    if record is None: return
                    record.headers(response)
                    if response.is_stream_consumed:
                        record.finish(complete=False); return
                    original_iter_bytes = response.iter_bytes
                    @functools.wraps(original_iter_bytes)
                    def iter_bytes(*args, **kwargs):
                        observing = record.begin_decoded()
                        error = None
                        try:
                            for chunk in original_iter_bytes(*args, **kwargs):
                                if observing:
                                    try: record.decoded_body(chunk)
                                    except Exception:
                                        record.invalidate_sse()
                                        self.unavailable('TRACE_HOOK_UNAVAILABLE')
                                yield chunk
                        except GeneratorExit:
                            raise
                        except BaseException as caught:
                            error = caught
                            raise
                        finally:
                            if observing: record.end_decoded(error)
                    response.iter_bytes = iter_bytes
                    stream = response.stream
                    class TracedStream(httpx.SyncByteStream):
                        def __iter__(self):
                            try:
                                for chunk in stream:
                                    try: record.body(chunk)
                                    except Exception: pass
                                    yield chunk
                            except GeneratorExit:
                                record.finish(complete=False); raise
                            except BaseException as error:
                                record.finish(error); raise
                            else: record.finish(complete=True)
                        def close(self):
                            try: stream.close()
                            except BaseException as error:
                                record.finish(error); raise
                            finally: record.finish(complete=False)
                    response.stream = TracedStream()
                except Exception: self.unavailable('TRACE_HOOK_UNAVAILABLE')
            @functools.wraps(original)
            def send(request, *args, **kwargs):
                try: return original(request, *args, **kwargs)
                except BaseException as error:
                    with self.lock: record = self.requests.get(request)
                    if record is not None: record.finish(error)
                    raise
            client.event_hooks['request'].append(request_hook)
            client.event_hooks['response'].append(response_hook)
            client.send = send
            client._workbench_model_request_tracer = self
            return True
        except ImportError:
            self.unavailable('TRACE_TRANSPORT_UNAVAILABLE'); return False
        except Exception:
            self.unavailable('TRACE_HOOK_UNAVAILABLE'); return False

    def attach_sdk_client(self, client):
        return self.attach_http_client(getattr(client, '_client', None))

    def attach_agent(self, agent):
        attached = False
        before = self.unavailable_count
        for name in ('client', '_anthropic_client'):
            attached = self.attach_sdk_client(getattr(agent, name, None)) or attached
        for name in _FACTORIES:
            original = getattr(agent, name, None)
            if not callable(original) or getattr(original, '_workbench_model_trace_factory', False): continue
            @functools.wraps(original)
            def factory(*args, _original=original, **kwargs):
                client = _original(*args, **kwargs)
                try: self.attach_sdk_client(client)
                except Exception: self.unavailable('TRACE_HOOK_UNAVAILABLE')
                return client
            factory._workbench_model_trace_factory = True
            setattr(agent, name, factory)
        if not attached and self.unavailable_count == before: self.unavailable('TRACE_CLIENT_UNAVAILABLE')
        return attached
