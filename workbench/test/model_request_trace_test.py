"""Bounded tracing tests. Synthetic traffic only; no model, auth or configuration."""
import asyncio
from contextlib import contextmanager
import gzip
import errno
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import ssl
import socket
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from model_request_trace import ModelRequestTracer, SSECounter
import model_request_trace as trace_module

try:
    import httpx
except ImportError:
    httpx = None


class SSECounterTests(unittest.TestCase):
    def test_failed_phases_are_independent_bounded_metadata_not_joined_into_final_causes(self):
        tracer = ModelRequestTracer(lambda value: None, request_id=str(uuid.uuid4()))
        record = trace_module._Request(tracer, 1); clock = [1.0]
        record.elapsed = lambda: clock[0]
        reset = ConnectionResetError(errno.ECONNRESET, 'PRIVATE_HOST')
        record.core('PRIVATE_PHASE.failed', {'exception': reset, 'PRIVATE_HEADERS': 'PRIVATE'})
        self.assertEqual(record.snapshot()['transportFailures'], [])
        phases = ['connection.connect_tcp.failed', 'connection.start_tls.failed', 'proxy.start_tls.failed',
                  'http11.receive_response_body.failed', 'http2.receive_response_body.failed']
        for index, phase in enumerate(phases):
            clock[0] = index + 2.0; record.core(phase, {'exception': reset, 'PRIVATE_INFO': 'PRIVATE'})
        value = record.snapshot()
        self.assertEqual(len(value['transportFailures']), 4)
        self.assertTrue(value['transportFailuresTruncated'])
        clock[0] = 8.0; record.core(phases[0], {'exception': reset})
        self.assertEqual(record.snapshot()['transportFailures'][0]['atMs'], 8.0)
        self.assertIsNone(record.snapshot()['error']['causeChain'])
        self.assertNotIn('PRIVATE', json.dumps(record.snapshot()))
    def test_event_times_follow_complete_frame_observation_and_ignore_unknown_event_names(self):
        counter = SSECounter()
        counter.feed(b'event: response.output_text.delta\ndata: PRIVATE', at_ms=100)
        counter.feed(b'\n\n', at_ms=125)
        counter.feed(b'event: response.output_text.delta\ndata: PRIVATE\n\nevent: PRIVATE_EVENT\ndata: PRIVATE\n\n', at_ms=300)
        self.assertEqual(counter.snapshot()['eventTimings'], {'response.output_text.delta': {'firstMs': 125, 'lastMs': 300}})
        self.assertNotIn('PRIVATE', json.dumps(counter.snapshot()))

    def test_cause_chain_is_bounded_sanitized_and_does_not_confuse_ssl_errno_with_os(self):
        reset = ConnectionResetError(errno.ECONNRESET, 'PRIVATE_ADDRESS_SECRET')
        eof = ssl.SSLEOFError(8, 'PRIVATE_TLS_MESSAGE')
        eof.__cause__ = reset
        value = trace_module._cause_details(eof)
        self.assertEqual(value['causeChain'], [
            {'class': 'ssl.SSLEOFError', 'errno': None, 'errnoName': None},
            {'class': 'builtins.ConnectionResetError', 'errno': errno.ECONNRESET, 'errnoName': 'ECONNRESET'}])
        self.assertFalse(value['causeChainTruncated'])
        self.assertNotIn('PRIVATE', json.dumps(value))
        unknown = type('PRIVATE_CLASS', (Exception,), {})('PRIVATE_MESSAGE')
        unknown.__context__ = reset
        unknown.__suppress_context__ = True
        self.assertEqual(trace_module._cause_details(unknown)['causeChain'], [{'class': 'unknown', 'errno': None, 'errnoName': None}])
        unknown.__cause__ = unknown
        self.assertTrue(trace_module._cause_details(unknown)['causeChainTruncated'])
        current = unknown = Exception('PRIVATE')
        for _ in range(20):
            current.__cause__ = Exception('PRIVATE'); current = current.__cause__
        self.assertEqual(len(trace_module._cause_details(unknown)['causeChain']), 6)
        self.assertTrue(trace_module._cause_details(unknown)['causeChainTruncated'])

    def test_maximum_trace_metadata_stays_within_existing_eight_kib_budget(self):
        tracer = ModelRequestTracer(lambda value: None, request_id=str(uuid.uuid4()))
        record = trace_module._Request(tracer, 1, {'maxRetries': 100, 'source': 'sdk-client'})
        record.elapsed = lambda: 999999999999.999
        record.observable['sse'] = 'observed'; record.sse_unavailable_reason = None
        record.http.update(status=599, requestId='r' * 128, requestIdHeader='x-request-id',
                           responseFormat='event-stream', contentEncoding='gzip', retryAfterSeconds=999999999)
        record.timings = {key: 999999999999.999 for key in record.timings}
        record.transport_failures = [
            {'phase': phase, 'atMs': 999999999999.999, 'causeChain': [
                {'class': 'builtins.ConnectionAbortedError', 'errno': 10053, 'errnoName': 'ECONNABORTED'} for _ in range(6)],
             'causeChainTruncated': True} for phase in ('http11.receive_response_headers.failed',
                'http2.receive_response_headers.failed', 'http11.send_request_headers.failed', 'http2.send_request_headers.failed')]
        record.transport_failures_truncated = True
        for event in sorted(trace_module.SSE_TYPES):
            record.counter.feed(('event: ' + event + '\ndata: PRIVATE\n\n').encode(), at_ms=999999999998.111)
            record.counter.feed(('event: ' + event + '\ndata: PRIVATE\n\n').encode(), at_ms=999999999999.001)
            record.counter.events[event] = 1_000_000
        error = current = ConnectionResetError(errno.ECONNRESET, 'PRIVATE')
        for _ in range(8):
            current.__cause__ = ConnectionResetError(errno.ECONNRESET, 'PRIVATE'); current = current.__cause__
        record.finish(error)
        encoded = json.dumps(record.snapshot(), separators=(',', ':'))
        self.assertLessEqual(len(encoded.encode()), 8192)
        self.assertNotIn('PRIVATE', encoded)

    def test_fragmented_events_keep_only_fixed_types_and_never_retain_data(self):
        counter = SSECounter()
        for chunk in [b'event: response.reasoning_summary_text.', b'delta\ndata: PRIVATE_THINKING\n\n',
                      b'data: PRIVATE_BODY\n\nevent: PRIVATE_UNKNOWN_EVENT\ndata: SECRET\n\n']:
            counter.feed(chunk)
        value = counter.snapshot()
        self.assertEqual(value['events'], {'response.reasoning_summary_text.delta': 1, 'message': 1})
        self.assertEqual(value['otherEvents'], 1)
        self.assertNotIn('PRIVATE', json.dumps(value))
        self.assertNotIn('SECRET', repr(counter.__dict__))
        counter.feed(b'data:' + b'x' * 1_000_000)
        self.assertLess(len(repr(counter.__dict__)), 2000)

    def test_oversized_unknown_event_and_counts_are_bounded(self):
        counter = SSECounter()
        counter.feed(b'event:' + b'PRIVATE' * 1000 + b'\ndata: ignored\n\n')
        self.assertEqual(counter.snapshot(), {'events': {}, 'otherEvents': 1, 'truncated': True, 'eventTimings': {}})
        counter.events['message'] = 1_000_000
        counter.feed(b'data\n\n')
        self.assertEqual(counter.snapshot()['events']['message'], 1_000_000)
        self.assertNotIn('PRIVATE', repr(counter.__dict__))

    def test_unavailable_metadata_is_bounded_and_stable_within_one_control_request(self):
        events = []
        tracer = ModelRequestTracer(events.append, request_id=str(uuid.uuid4()))
        for _ in range(100): tracer.unavailable('TRACE_CLIENT_UNAVAILABLE')
        tracer.unavailable('TRACE_HOOK_UNAVAILABLE', error=RuntimeError('PRIVATE_MESSAGE'))
        self.assertEqual(len(events), 2)
        self.assertEqual(len({value['traceId'] for value in events}), 1)
        self.assertEqual(len({value['startedAt'] for value in events}), 1)
        self.assertNotIn('PRIVATE', json.dumps(events))
        tracer.set_request_id(str(uuid.uuid4()))
        tracer.unavailable('TRACE_CLIENT_UNAVAILABLE')
        self.assertNotEqual(events[-1]['traceId'], events[0]['traceId'])


@contextmanager
def synthetic_server(payload=None, encoding=None, content_type='text/event-stream', reset_after=None):
    payload = payload if payload is not None else (b'event: response.created\r\ndata: PRIVATE_BODY\r\n\r\n'
               b'event: response.reasoning_text.delta\ndata: PRIVATE_THINKING\n\n'
               b'event: PRIVATE_EVENT\ndata: PRIVATE_SECRET\n\n'
               b'event: response.completed\ndata: PRIVATE_RESULT\n\n')
    wire_payload = gzip.compress(payload) if encoding == 'gzip' else payload
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def do_POST(self):
            self.rfile.read(int(self.headers.get('content-length', '0')))
            self.send_response(200)
            if content_type is not None: self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(wire_payload) + (100 if reset_after is not None else 0)))
            if encoding: self.send_header('Content-Encoding', encoding)
            self.send_header('x-request-id', 'synthetic-request-123')
            self.send_header('Retry-After', '2')
            self.send_header('Set-Cookie', 'PRIVATE_COOKIE')
            self.send_header('x-private-header', 'PRIVATE_HEADER')
            self.end_headers()
            for start in range(0, len(wire_payload), 11):
                self.wfile.write(wire_payload[start:start + 11]); self.wfile.flush()
            if reset_after is not None:
                reset_after.wait(timeout=3)
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                self.close_connection = True
                self.rfile.close(); self.wfile.close(); self.connection.close()
                self.wfile = io.BytesIO()  # Base handler's final flush is harmless after the deliberate reset.
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port) + '/v1/responses', payload
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


@unittest.skipUnless(httpx is not None, 'existing Hermes httpx dependency is required for transport integration tests')
class HttpTraceTests(unittest.TestCase):
    def tracer(self, events):
        return ModelRequestTracer(events.append, request_id=str(uuid.uuid4()))

    def test_sdk_retry_policy_is_actual_client_number_frozen_per_http_attempt(self):
        events = []; tracer = self.tracer(events)
        class SDK:
            def __init__(self, client): self._client, self.max_retries = client, 2
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'PRIVATE'))) as client:
            sdk = SDK(client)
            tracer.attach_sdk_client(sdk)
            with tracer.turn():
                client.post('https://private.invalid/v1/responses')
                sdk.max_retries = 0
                client.post('https://private.invalid/v1/responses')
                sdk.max_retries = 'PRIVATE_NOT_A_NUMBER'
                client.post('https://private.invalid/v1/responses')
        actual = [event for event in events if event['status'] == 'complete']
        self.assertEqual([event['sdkRetryPolicy'] for event in actual], [
            {'maxRetries': 2, 'source': 'sdk-client'}, {'maxRetries': 0, 'source': 'sdk-client'}, None])
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_httpx_httpcore_reset_chain_is_retained_without_messages(self):
        import httpcore
        events = []; tracer = self.tracer(events)
        reset = ConnectionResetError(errno.ECONNRESET, 'PRIVATE_RESET_ADDRESS')
        middle = httpcore.ReadError('PRIVATE_CORE'); middle.__cause__ = reset
        error = httpx.ReadError('PRIVATE_HTTPX'); error.__cause__ = middle
        class Broken(httpx.SyncByteStream):
            def __iter__(self):
                yield b'event: response.output_text.delta\ndata: PRIVATE\n\n'
                raise error
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
                200, headers={'Content-Type': 'text/event-stream'}, stream=Broken()))) as client:
            tracer.attach_http_client(client)
            with self.assertRaises(httpx.ReadError) as caught, tracer.turn():
                client.post('https://private.invalid/v1/responses')
            self.assertIs(caught.exception, error)
        final = [event for event in events if event['requestIndex'] == 1][-1]
        self.assertEqual([item['class'] for item in final['error']['causeChain']], [
            'httpx.ReadError', 'httpcore.ReadError', 'builtins.ConnectionResetError'])
        self.assertEqual(final['error']['causeChain'][-1]['errnoName'], 'ECONNRESET')
        self.assertEqual(final['error']['type'], 'ReadError')
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_installed_sdk_localhost_midstream_reset_records_real_transport_causes_without_retrying(self):
        try:
            from openai import OpenAI
        except ImportError:
            self.skipTest('existing Hermes OpenAI SDK dependency is required')
        payload = b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PRIVATE_RESULT"}\n\n'
        received = threading.Event(); events = []; tracer = self.tracer(events)
        with synthetic_server(payload, content_type=None, reset_after=received) as (url, _), httpx.Client(trust_env=False, timeout=3) as transport:
            with OpenAI(api_key='synthetic-not-a-real-key', base_url=url.rsplit('/responses', 1)[0] + '/',
                        http_client=transport, max_retries=0) as sdk:
                tracer.attach_agent(SimpleNamespace(client=sdk))
                with self.assertRaises((httpx.ReadError, httpx.RemoteProtocolError)), tracer.turn():
                    for event in sdk.responses.create(model='synthetic-model', input='PRIVATE_PROMPT', stream=True):
                        self.assertEqual(event.delta, 'PRIVATE_RESULT'); received.set()
        self.assertTrue(received.is_set())
        actual = [event for event in events if event['requestIndex'] == 1]
        final = actual[-1]
        self.assertEqual(final['status'], 'error')
        self.assertEqual(final['sdkRetryPolicy'], {'maxRetries': 0, 'source': 'sdk-client'})
        classes = [item['class'] for item in final['error']['causeChain']]
        self.assertTrue(classes[0] in ('httpx.ReadError', 'httpx.RemoteProtocolError'))
        self.assertTrue(any(name.startswith('httpcore.') for name in classes))
        failures = final['transportFailures']
        self.assertTrue(failures)
        self.assertTrue(all(0 <= failure['atMs'] <= final['durationMs'] for failure in failures))
        if final['error']['type'] == 'ReadError':
            self.assertTrue(any(item['errnoName'] == 'ECONNRESET' for failure in failures for item in failure['causeChain']))
            self.assertFalse(any(item['errnoName'] == 'ECONNRESET' for item in final['error']['causeChain']))
        # httpcore may explicitly re-raise from None, removing the OS cause.
        # That absence remains unknown; the observer never invents a reset errno.
        self.assertEqual(final['sse']['events'], {'response.output_text.delta': 1})
        self.assertIn('response.output_text.delta', final['sse']['eventTimings'])
        self.assertEqual(tracer.index, 1)
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_real_local_stream_cross_thread_has_only_metadata_and_preserves_existing_hooks(self):
        events, original_hooks, core_events, failures, output = [], [], [], [], []
        tracer = self.tracer(events)
        original_send = httpx.Client.send
        with synthetic_server() as (url, expected), httpx.Client(trust_env=False, timeout=3,
                event_hooks={'request': [lambda request: original_hooks.append('request')],
                             'response': [lambda response: original_hooks.append('response')]}) as client:
            self.assertTrue(tracer.attach_sdk_client(SimpleNamespace(_client=client)))
            def worker():
                try:
                    request = client.build_request('POST', url, content=b'PRIVATE_PROMPT',
                                                   headers={'Authorization': 'PRIVATE_AUTH', 'Cookie': 'PRIVATE_COOKIE'})
                    request.extensions['trace'] = lambda event, info: core_events.append(event)
                    response = client.send(request, stream=True)
                    try:
                        output.append(b''.join(response.iter_bytes(chunk_size=7)))
                    finally:
                        response.close()
                except BaseException as error:
                    failures.append(error)
            with tracer.turn():
                thread = threading.Thread(target=worker); thread.start(); thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(output, [expected])
                # A separate business client remains completely unobserved.
                count = len(events)
                with httpx.Client(trust_env=False, timeout=3) as ordinary:
                    ordinary.post(url, content=b'PRIVATE_ORDINARY')
                self.assertEqual(len(events), count)
            before = len(events)
            client.post(url, content=b'PRIVATE_OUTSIDE_ACTIVE_TURN')
            self.assertEqual(len(events), before)
        self.assertIs(httpx.Client.send, original_send)
        self.assertEqual(original_hooks, ['request', 'response', 'request', 'response'])
        self.assertIn('connection.connect_tcp.complete', core_events)
        final = events[-1]
        self.assertEqual(final['status'], 'complete')
        self.assertTrue(final['bodyComplete'])
        self.assertEqual(final['requestId'], tracer.request_id)
        self.assertEqual(final['http'], {'status': 200, 'requestId': 'synthetic-request-123',
                         'requestIdHeader': 'x-request-id', 'retryAfterSeconds': 2,
                         'responseFormat': 'event-stream', 'contentEncoding': 'identity'})
        self.assertEqual(final['observability'], {'dns': 'unavailable', 'connect': 'observed', 'tls': 'unavailable',
                                                 'headers': 'observed', 'sse': 'observed'})
        for name in ('connectMs', 'headersMs', 'firstBodyByteMs', 'lastBodyByteMs'):
            self.assertGreaterEqual(final['timings'][name], 0)
        self.assertIsNone(final['timings']['tlsMs'])
        self.assertEqual(final['sse']['events'], {'response.created': 1, 'response.reasoning_text.delta': 1, 'response.completed': 1})
        self.assertEqual(final['sse']['otherEvents'], 1)
        serialized = json.dumps(events)
        for private in ('PRIVATE', url, '127.0.0.1', 'Authorization', 'Cookie', 'x-private-header'):
            self.assertNotIn(private, serialized)

    def test_two_private_clients_and_late_factory_keep_thread_attribution(self):
        with synthetic_server() as (url, expected):
            clients, events = [], [[], []]
            class Agent:
                def _create_openai_client(self):
                    client = httpx.Client(trust_env=False, timeout=3)
                    clients.append(client)
                    return SimpleNamespace(_client=client)
            agents = [Agent(), Agent()]
            tracers = [self.tracer(values) for values in events]
            for tracer, agent in zip(tracers, agents):
                self.assertFalse(tracer.attach_agent(agent))
                self.assertEqual(events[tracers.index(tracer)][-1]['code'], 'TRACE_CLIENT_UNAVAILABLE')
            errors = []
            def worker(index):
                try:
                    with tracers[index].turn():
                        sdk = agents[index]._create_openai_client()
                        self.assertEqual(sdk._client.post(url, content=b'PRIVATE').content, expected)
                except BaseException as error:
                    errors.append(error)
            threads = [threading.Thread(target=worker, args=(index,)) for index in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(timeout=5)
            try:
                self.assertEqual(errors, [])
                for index, values in enumerate(events):
                    self.assertEqual({value['requestId'] for value in values}, {tracers[index].request_id})
                    self.assertEqual(values[-1]['requestIndex'], 1)
                    self.assertTrue(values[-1]['bodyComplete'])
                self.assertNotEqual(events[0][-1]['traceId'], events[1][-1]['traceId'])
            finally:
                for client in clients: client.close()

    def test_installed_openai_sdk_responses_stream_uses_private_httpx_hook(self):
        try:
            from openai import OpenAI
        except ImportError:
            self.skipTest('existing Hermes OpenAI SDK dependency is required')
        payload = (b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PRIVATE_RESULT"}\n\n'
                   b'data: [DONE]\n\n')
        events = []; tracer = self.tracer(events)
        with synthetic_server(payload) as (url, _), httpx.Client(trust_env=False, timeout=3) as transport:
            with OpenAI(api_key='synthetic-not-a-real-key', base_url=url.rsplit('/responses', 1)[0] + '/',
                        http_client=transport, max_retries=0) as sdk:
                self.assertTrue(tracer.attach_agent(SimpleNamespace(client=sdk)))
                with tracer.turn():
                    response = list(sdk.responses.create(model='synthetic-model', input='PRIVATE_PROMPT', stream=True))
                self.assertEqual(response[0].delta, 'PRIVATE_RESULT')
        self.assertEqual(events[-1]['sse']['events'], {'response.output_text.delta': 1, 'message': 1})
        # The SDK stops at [DONE] before asking for raw socket EOF. A false
        # bodyComplete is an observation, not a claim that model execution failed.
        self.assertFalse(events[-1]['bodyComplete'])
        self.assertNotIn('PRIVATE', json.dumps(events))
        self.assertNotIn('synthetic-not-a-real-key', json.dumps(events))

    def test_errors_http_retries_cancellation_and_premature_close_do_not_leak_messages(self):
        cases = [(httpx.ConnectTimeout('PRIVATE_HOST_KEY'), 'ConnectTimeout', 'transport'),
                 (httpx.ConnectError('PRIVATE_PROXY_URL'), 'ConnectError', 'transport'),
                 (asyncio.CancelledError('PRIVATE_CANCEL_REASON'), 'CancelledError', 'cancelled')]
        for error, kind, source in cases:
            with self.subTest(kind=kind):
                events = []; tracer = self.tracer(events)
                def fail(request): raise error
                with httpx.Client(transport=httpx.MockTransport(fail)) as client:
                    tracer.attach_http_client(client)
                    with self.assertRaises(type(error)), tracer.turn():
                        client.post('https://private.invalid/v1/responses', content=b'PRIVATE')
                finals = [value for value in events if value['requestIndex'] == 1]
                self.assertEqual({key: finals[-1]['error'][key] for key in ('type', 'source')}, {'type': kind, 'source': source})
                self.assertFalse(finals[-1]['bodyComplete'])
                self.assertNotIn('PRIVATE', json.dumps(events))
        events = []; tracer = self.tracer(events)
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(429,
                headers={'Retry-After': '3', 'x-request-id': 'sk-PRIVATE_KEY', 'request-id': 'safe-456'}, content=b'PRIVATE'))) as client:
            tracer.attach_http_client(client)
            with tracer.turn(): client.post('https://private.invalid/v1/messages')
        self.assertEqual(events[-1]['error'], {'type': 'HTTPStatusError', 'source': 'http', 'causeChain': None, 'causeChainTruncated': None})
        self.assertEqual(events[-1]['http']['retryAfterSeconds'], 3)
        self.assertEqual(events[-1]['http']['requestId'], 'safe-456')
        class TwoChunks(httpx.SyncByteStream):
            def __iter__(self): yield b'data: PRIVATE\n\n'; yield b'data: PRIVATE\n\n'
        events = []; tracer = self.tracer(events)
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200,
                headers={'Content-Type': 'text/event-stream'}, stream=TwoChunks()))) as client:
            tracer.attach_http_client(client)
            with tracer.turn(), client.stream('POST', 'https://private.invalid/v1/responses') as response:
                self.assertTrue(next(response.iter_bytes()))
        self.assertFalse(events[-1]['bodyComplete'])

    def test_request_and_emission_limits_and_shared_client_refusal(self):
        events = []; tracer = self.tracer(events)
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'PRIVATE'))) as client:
            self.assertTrue(tracer.attach_http_client(client))
            other = []; competing = self.tracer(other)
            self.assertFalse(competing.attach_http_client(client))
            self.assertEqual(other[-1]['code'], 'TRACE_HOOK_UNAVAILABLE')
            with tracer.turn():
                for _ in range(35): client.post('https://private.invalid/v1/chat/completions')
            self.assertEqual(max(value['requestIndex'] for value in events), 32)
            self.assertEqual(sum(value.get('code') == 'TRACE_REQUEST_LIMIT' for value in events), 1)
            by_id = {}
            for event in events:
                by_id.setdefault(event['traceId'], []).append(event)
            self.assertTrue(all(len(values) <= 17 for values in by_id.values()))
            self.assertEqual(len(other), 1)

    def test_gzip_sse_is_counted_after_decoding_without_changing_bytes_or_recounting_cache(self):
        events = []; tracer = self.tracer(events)
        self.assertFalse(tracer.attach_http_client(object()))
        self.assertEqual(events[-1]['code'], 'TRACE_TRANSPORT_UNAVAILABLE')
        expected = b'event: response.completed\ndata: PRIVATE\n\n'
        content = gzip.compress(expected)
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200,
                headers={'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip'},
                stream=httpx.ByteStream(content)))) as client:
            tracer.attach_http_client(client)
            with tracer.turn():
                response = client.post('https://private.invalid/v1/responses')
                self.assertEqual(response.content, expected)
                before = len(events)
                self.assertEqual(b''.join(response.iter_bytes(chunk_size=2)), expected)
                self.assertEqual(b''.join(response.iter_bytes()), expected)
                self.assertEqual(len(events), before)
        self.assertEqual(events[-1]['observability']['sse'], 'observed')
        self.assertEqual(events[-1]['sse']['events'], {'response.completed': 1})
        self.assertEqual(events[-1]['http']['responseFormat'], 'event-stream')
        self.assertEqual(events[-1]['http']['contentEncoding'], 'gzip')
        self.assertIsNone(events[-1]['sse']['unavailableReason'])
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_response_headers_project_only_safe_format_encoding_and_sse_reason_enums(self):
        cases = [({}, 'unknown', 'identity', 'unknown'),
                 ({'Content-Type': 'text/event-stream'}, 'event-stream', 'identity', 'decoded-stream-unobserved'),
                 ({'Content-Type': 'Text/Event-Stream; charset=utf-8', 'Content-Encoding': 'gzip'}, 'event-stream', 'gzip', 'decoded-stream-unobserved'),
                 ({'Content-Type': 'application/json', 'Content-Encoding': 'deflate'}, 'json', 'deflate', 'not-event-stream'),
                 ({'Content-Type': 'application/problem+json', 'Content-Encoding': 'br'}, 'json', 'br', 'not-event-stream'),
                 ({'Content-Type': 'application/json; PRIVATE_PARAMETER=PRIVATE_HEADER', 'Content-Encoding': 'zstd'}, 'json', 'zstd', 'not-event-stream'),
                 ({'Content-Type': 'text/plain', 'Content-Encoding': 'identity'}, 'other', 'identity', 'not-event-stream'),
                 ({'Content-Type': 'PRIVATE_TYPE', 'Content-Encoding': 'PRIVATE_ENCODING'}, 'other', 'other', 'not-event-stream'),
                 ({'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip, br'}, 'event-stream', 'other', 'decoded-stream-unobserved')]
        for headers, response_format, encoding, reason in cases:
            with self.subTest(response_format=response_format, encoding=encoding, reason=reason):
                events = []; tracer = self.tracer(events)
                with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
                        200, headers=headers, stream=httpx.ByteStream(b'PRIVATE_BODY')))) as client:
                    tracer.attach_http_client(client)
                    # Intentionally do not invoke a decoder; no response body is inspected.
                    with tracer.turn(), client.stream('POST', 'https://private.invalid/v1/responses'):
                        pass
                self.assertEqual(events[0]['http']['responseFormat'], 'unknown')
                self.assertIsNone(events[0]['http']['contentEncoding'])
                self.assertEqual(events[0]['sse']['unavailableReason'], 'unknown')
                final = events[-1]
                self.assertEqual(final['http']['responseFormat'], response_format)
                self.assertEqual(final['http']['contentEncoding'], encoding)
                self.assertEqual(final['sse']['unavailableReason'], reason)
                self.assertEqual(final['observability']['sse'], 'unavailable')
                self.assertNotIn('PRIVATE', json.dumps(events))

    def test_decoded_flush_tail_is_included_once_in_final_snapshot(self):
        events = []; tracer = self.tracer(events)
        first = b'event: response.created\ndata: PRIVATE_FIRST\n\n'
        tail = b'event: response.completed\ndata: PRIVATE_TAIL\n\n'
        def handler(request):
            response = httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, stream=httpx.ByteStream(b'PRIVATE_RAW'))
            response._get_content_decoder = lambda: SimpleNamespace(decode=lambda chunk: first, flush=lambda: tail)
            return response
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            tracer.attach_http_client(client)
            with tracer.turn():
                self.assertEqual(client.post('https://private.invalid/v1/responses').content, first + tail)
        final = events[-1]
        self.assertEqual(final['sse']['events'], {'response.created': 1, 'response.completed': 1})
        self.assertTrue(final['bodyComplete'])
        self.assertEqual(sum(value['status'] == 'complete' for value in events), 1)

    def test_decoder_flush_failure_preserves_original_error_and_private_safe_terminal(self):
        events = []; tracer = self.tracer(events)
        error = httpx.DecodingError('PRIVATE_DECODER_MESSAGE')
        def fail_flush(): raise error
        def handler(request):
            response = httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, stream=httpx.ByteStream(b'PRIVATE_RAW'))
            response._get_content_decoder = lambda: SimpleNamespace(
                decode=lambda chunk: b'event: response.created\ndata: PRIVATE\n\n', flush=fail_flush)
            return response
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            tracer.attach_http_client(client)
            with self.assertRaises(httpx.DecodingError) as caught, tracer.turn():
                client.post('https://private.invalid/v1/responses')
            self.assertIs(caught.exception, error)
        actual = [event for event in events if event['requestIndex'] == 1]
        self.assertEqual(actual[-1]['status'], 'error')
        self.assertTrue(actual[-1]['bodyComplete'])
        self.assertEqual(actual[-1]['error'], {'source': 'sdk', 'type': 'SDKError',
            'causeChain': [{'class': 'httpx.DecodingError', 'errno': None, 'errnoName': None}], 'causeChainTruncated': False})
        self.assertEqual(sum(event['status'] == 'error' for event in actual), 1)
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_observer_parser_failure_does_not_interrupt_original_decoded_stream(self):
        events = []; tracer = self.tracer(events)
        expected = b'event: response.completed\ndata: PRIVATE\n\n'
        with patch.object(SSECounter, 'feed', side_effect=RuntimeError('PRIVATE_PARSER_FAILURE')), httpx.Client(
                transport=httpx.MockTransport(lambda request: httpx.Response(200,
                    headers={'Content-Type': 'text/event-stream'}, stream=httpx.ByteStream(expected)))) as client:
            tracer.attach_http_client(client)
            with tracer.turn(): self.assertEqual(client.post('https://private.invalid/v1/responses').content, expected)
        actual = [event for event in events if event['requestIndex'] == 1]
        self.assertEqual(actual[-1]['status'], 'complete')
        self.assertEqual(actual[-1]['observability']['sse'], 'unavailable')
        self.assertEqual(actual[-1]['sse'], {'events': {}, 'otherEvents': 0, 'truncated': True, 'unavailableReason': 'parser-error', 'eventTimings': {}})
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_compressed_observation_quota_falls_back_unknown_without_interrupting_sdk_bytes(self):
        events = []; tracer = self.tracer(events)
        expected = b'event: response.output_text.delta\ndata: ' + b'PRIVATE' * 10000 + b'\n\n'
        content = gzip.compress(expected)
        with patch.object(trace_module, 'MAX_SSE_OBSERVED_BYTES', 128, create=True), httpx.Client(
                transport=httpx.MockTransport(lambda request: httpx.Response(200,
                    headers={'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip'},
                    stream=httpx.ByteStream(content)))) as client:
            tracer.attach_http_client(client)
            with tracer.turn():
                self.assertEqual(client.post('https://private.invalid/v1/responses').content, expected)
        self.assertEqual(events[-1]['observability']['sse'], 'unavailable')
        self.assertEqual(events[-1]['sse'], {'events': {}, 'otherEvents': 0, 'truncated': True, 'unavailableReason': 'observation-limit', 'eventTimings': {}})
        self.assertEqual(events[-1]['status'], 'complete')
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_proxy_and_connection_tls_stages_are_observed_without_private_trace_info(self):
        events = []; tracer = self.tracer(events); now = [10.0]
        def handler(request):
            trace = request.extensions['trace']
            for phase, duration in [('connection.connect_tcp', 0.01), ('connection.start_tls', 0.02), ('proxy.start_tls', 0.03)]:
                trace(phase + '.started', {'PRIVATE_SERVER_HOST': 'PRIVATE_ADDRESS'})
                now[0] += duration
                trace(phase + '.complete', {'return_value': 'PRIVATE_STREAM'})
            return httpx.Response(200, content=b'PRIVATE')
        with patch.object(trace_module.time, 'monotonic', lambda: now[0]), httpx.Client(transport=httpx.MockTransport(handler)) as client:
            tracer.attach_http_client(client)
            with tracer.turn(): client.post('https://private.invalid/v1/responses')
        self.assertEqual(events[-1]['timings']['connectMs'], 10)
        self.assertEqual(events[-1]['timings']['tlsMs'], 50)
        self.assertEqual(events[-1]['observability']['tls'], 'observed')
        self.assertEqual(events[-1]['observability']['dns'], 'unavailable')
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_installed_sdk_decodes_gzip_sse_with_unchanged_result_and_private_safe_trace(self):
        try:
            from openai import OpenAI
        except ImportError:
            self.skipTest('existing Hermes OpenAI SDK dependency is required')
        payload = (b'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"PRIVATE_THINK"}\n\n'
                   b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PRIVATE_RESULT"}\n\n'
                   b'data: [DONE]\n\n')
        events = []; tracer = self.tracer(events)
        with synthetic_server(payload, encoding='gzip') as (url, _), httpx.Client(trust_env=False, timeout=3) as transport:
            with OpenAI(api_key='synthetic-not-a-real-key', base_url=url.rsplit('/responses', 1)[0] + '/',
                        http_client=transport, max_retries=0) as sdk:
                tracer.attach_agent(SimpleNamespace(client=sdk))
                with tracer.turn():
                    response = list(sdk.responses.create(model='synthetic-model', input='PRIVATE_PROMPT', stream=True))
                self.assertEqual([event.delta for event in response], ['PRIVATE_THINK', 'PRIVATE_RESULT'])
        self.assertEqual(events[-1]['sse']['events'], {'response.reasoning_text.delta': 1, 'response.output_text.delta': 1, 'message': 1})
        self.assertEqual(events[-1]['observability']['sse'], 'observed')
        self.assertEqual(events[-1]['http']['responseFormat'], 'event-stream')
        self.assertEqual(events[-1]['http']['contentEncoding'], 'gzip')
        self.assertIsNone(events[-1]['sse']['unavailableReason'])
        self.assertEqual(events[-1]['sdkRetryPolicy'], {'maxRetries': 0, 'source': 'sdk-client'})
        self.assertEqual(set(events[-1]['sse']['eventTimings']), set(events[-1]['sse']['events']))
        for timing in events[-1]['sse']['eventTimings'].values():
            self.assertLessEqual(timing['firstMs'], timing['lastMs'])
            self.assertLessEqual(timing['lastMs'], events[-1]['durationMs'])
        self.assertEqual(events[-1]['status'], 'complete')
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_installed_sdk_consumes_missing_mime_sse_and_observer_detects_only_framing(self):
        try:
            from openai import OpenAI
        except ImportError:
            self.skipTest('existing Hermes OpenAI SDK dependency is required')
        payload = (b'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"PRIVATE_THINK"}\n\n'
                   b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PRIVATE_RESULT"}\n\n'
                   b'data: [DONE]\n\n')
        events = []; tracer = self.tracer(events)
        with synthetic_server(payload, content_type=None) as (url, _), httpx.Client(trust_env=False, timeout=3) as transport:
            with OpenAI(api_key='synthetic-not-a-real-key', base_url=url.rsplit('/responses', 1)[0] + '/',
                        http_client=transport, max_retries=0) as sdk:
                tracer.attach_agent(SimpleNamespace(client=sdk))
                with tracer.turn():
                    result = list(sdk.responses.create(model='synthetic-model', input='PRIVATE_PROMPT', stream=True))
                self.assertEqual([event.delta for event in result], ['PRIVATE_THINK', 'PRIVATE_RESULT'])
        final = events[-1]
        self.assertEqual(final['http']['responseFormat'], 'unknown')
        self.assertEqual(final['http']['contentEncoding'], 'identity')
        self.assertEqual(final['observability']['sse'], 'observed')
        self.assertEqual(final['sse']['events'], {'response.reasoning_text.delta': 1, 'response.output_text.delta': 1, 'message': 1})
        self.assertIsNone(final['sse']['unavailableReason'])
        self.assertNotIn('PRIVATE', json.dumps(events))

    def test_missing_mime_non_sse_bytes_remain_unknown_and_declared_json_is_not_probed(self):
        for headers, expected in [({}, b'{"PRIVATE_BODY":"PRIVATE_VALUE"}'),
                                  ({'Content-Type': 'application/json'}, b'event: response.created\ndata: PRIVATE\n\n')]:
            with self.subTest(declared_json=bool(headers)):
                events = []; tracer = self.tracer(events)
                with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
                        200, headers=headers, stream=httpx.ByteStream(expected)))) as client:
                    tracer.attach_http_client(client)
                    with tracer.turn(): self.assertEqual(client.post('https://private.invalid/v1/responses').content, expected)
                final = events[-1]
                self.assertEqual(final['observability']['sse'], 'unavailable')
                self.assertEqual(final['sse']['events'], {})
                self.assertEqual(final['sse']['unavailableReason'], 'not-event-stream' if headers else 'unknown')
                self.assertNotIn('PRIVATE', json.dumps(events))

    def test_missing_mime_probe_recognizes_only_decoder_flush_tail_and_keeps_quota(self):
        for limit in (128, 1):
            with self.subTest(limit=limit):
                events = []; tracer = self.tracer(events)
                first, tail = b':keepalive\n\n', b'event: response.completed\ndata: PRIVATE\n\n'
                def handler(request):
                    response = httpx.Response(200, stream=httpx.ByteStream(b'PRIVATE_RAW'))
                    response._get_content_decoder = lambda: SimpleNamespace(decode=lambda chunk: first, flush=lambda: tail)
                    return response
                with patch.object(trace_module, 'MAX_SSE_OBSERVED_BYTES', limit), httpx.Client(transport=httpx.MockTransport(handler)) as client:
                    tracer.attach_http_client(client)
                    with tracer.turn(): self.assertEqual(client.post('https://private.invalid/v1/responses').content, first + tail)
                final = events[-1]
                self.assertTrue(final['bodyComplete'])
                self.assertEqual(final['http']['responseFormat'], 'unknown')
                self.assertEqual(final['observability']['sse'], 'observed' if limit == 128 else 'unavailable')
                self.assertEqual(final['sse']['events'], {'response.completed': 1} if limit == 128 else {})
                self.assertEqual(final['sse']['unavailableReason'], None if limit == 128 else 'observation-limit')
                self.assertEqual(sum(event['status'] == 'complete' for event in events), 1)
                self.assertNotIn('PRIVATE', json.dumps(events))

    def test_unrecognized_private_sdk_protocol_is_explicitly_unavailable_without_recording_path(self):
        events = []; tracer = self.tracer(events)
        with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'PRIVATE'))) as client:
            tracer.attach_http_client(client)
            with tracer.turn(): client.post('https://private.invalid/PRIVATE_UNSUPPORTED')
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['requestIndex'], 0)
        self.assertEqual(events[0]['code'], 'TRACE_TRANSPORT_UNAVAILABLE')
        self.assertNotIn('PRIVATE', json.dumps(events))


if __name__ == '__main__':
    unittest.main()
