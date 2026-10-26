"""Pure stdlib, injected runtime tests; never import Hermes or access user config."""
import copy
import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("workbench_hermes_models", Path(__file__).resolve().parents[1] / "python/hermes_models.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class Runtime:
    def __init__(self):
        self.calls = []
        self.current = {"provider": "custom:studio", "model": "initial"}
        self.rows = [{"slug": "custom:studio", "models": ["initial"], "authenticated": True},
                     {"slug": "offline", "models": ["test"], "authenticated": False}]
        self.document = {"model": {"provider": "custom:studio", "default": "initial", "base_url": "https://private.invalid"},
                         "providers": {"custom:studio": {"api_key": "fixture-secret"}},
                         "fallback_providers": [{"provider": "backup", "model": "backup-model"}],
                         "auxiliary": {"vision": {"provider": "other"}}}
        self.original = copy.deepcopy(self.document)
        self.warning_value = None
        self.fail_switch = False
        self.fail_persist = False
        self.stale_readback = False

    def inventory(self):
        self.calls.append(("inventory",))
        return {**self.current, "providers": copy.deepcopy(self.rows)}

    def config(self):
        self.calls.append(("config",))
        return copy.deepcopy(self.document)

    def custom_providers(self, document):
        return [{"name": "studio", "base_url": "https://private.invalid"}]

    def switch(self, **kwargs):
        self.calls.append(("switch", kwargs))
        if self.fail_switch:
            raise RuntimeError("fixture-secret https://private.invalid")
        return SimpleNamespace(success=True, target_provider=kwargs["explicit_provider"], new_model=kwargs["raw_input"],
                               base_url="https://private.invalid", api_key="fixture-secret", model_info=None, warning_message="")

    def warning(self, result):
        self.calls.append(("warning",))
        return self.warning_value

    def persist(self, result):
        self.calls.append(("persist",))
        if self.fail_persist:
            raise RuntimeError("fixture-secret https://private.invalid")
        self.document["model"].update(provider=result.target_provider, default=result.new_model)
        if not self.stale_readback:
            self.current = {"provider": result.target_provider, "model": result.new_model}


class ModelBridgeTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime()
        self.service = module.HermesModelSelection(self.runtime)

    def test_manual_model_and_named_custom_use_structured_canonical_hermes_switch_and_readback(self):
        result = self.service.set({"provider": "custom:studio", "model": "manual/new:2026"})
        self.assertEqual(result, {"provider": "custom:studio", "model": "manual/new:2026"})
        params = next(call[1] for call in self.runtime.calls if call[0] == "switch")
        self.assertEqual(params["raw_input"], "manual/new:2026")
        self.assertEqual(params["explicit_provider"], "custom:studio")
        self.assertIs(params["is_global"], True)
        self.assertEqual(params["current_api_key"], "")
        self.assertEqual([call[0] for call in self.runtime.calls], ["inventory", "config", "switch", "warning", "persist", "inventory"])
        for key in ["providers", "fallback_providers", "auxiliary"]:
            self.assertEqual(self.runtime.document[key], self.runtime.original[key])
        self.assertNotIn("fixture-secret", str(result))
        self.assertNotIn("private.invalid", str(result))

    def test_strict_envelopes_and_unconfigured_or_unauthed_providers_never_persist(self):
        for params in [None, [], {}, {"provider": "", "model": "x"}, {"provider": True, "model": "x"},
                       {"provider": "x" * 129, "model": "x"}, {"provider": "custom:studio", "model": "x" * 257},
                       {"provider": "custom:studio", "model": "x\ny"},
                       {"provider": "custom:studio", "model": "x", "api_key": "fixture-secret"}]:
            with self.subTest(params=params), self.assertRaises(module.ModelSelectionError) as error:
                self.service.set(params)
            self.assertEqual(error.exception.code, 4300)
        self.assertEqual(self.runtime.calls, [])
        for provider in ["absent", "offline"]:
            with self.assertRaises(module.ModelSelectionError) as error:
                self.service.set({"provider": provider, "model": "manual"})
            self.assertEqual(error.exception.code, 4301)
        self.assertTrue(all(call[0] == "inventory" for call in self.runtime.calls))

    def test_hermes_selection_warning_is_not_automatically_confirmed(self):
        self.runtime.warning_value = object()
        with self.assertRaises(module.ModelSelectionError) as error:
            self.service.set({"provider": "custom:studio", "model": "expensive"})
        self.assertEqual(error.exception.code, 4303)
        self.assertNotIn(("persist",), self.runtime.calls)
        self.assertEqual(self.runtime.document, self.runtime.original)

    def test_upstream_failures_never_expose_secret_or_endpoint(self):
        for failure in ["fail_switch", "fail_persist"]:
            setattr(self.runtime, failure, True)
            with self.assertRaises(module.ModelSelectionError) as error:
                self.service.set({"provider": "custom:studio", "model": "manual"})
            self.assertNotIn("fixture-secret", str(error.exception))
            self.assertNotIn("private.invalid", str(error.exception))
            setattr(self.runtime, failure, False)

    def test_unconfirmed_readback_is_explicit_and_never_rolls_back_other_user_changes(self):
        self.runtime.stale_readback = True
        with self.assertRaises(module.ModelSelectionError) as error:
            self.service.set({"provider": "custom:studio", "model": "manual"})
        self.assertEqual(error.exception.code, 4304)
        self.assertEqual(self.runtime.document["model"]["default"], "manual")
        self.assertEqual(self.runtime.document["fallback_providers"], self.runtime.original["fallback_providers"])

    def test_duplicate_provider_id_is_ambiguous_and_rejected(self):
        self.runtime.rows.append(copy.deepcopy(self.runtime.rows[0]))
        with self.assertRaises(module.ModelSelectionError) as error:
            self.service.set({"provider": "custom:studio", "model": "manual"})
        self.assertEqual(error.exception.code, 4301)
        self.assertNotIn(("persist",), self.runtime.calls)

    def test_selector_cannot_return_the_previous_or_another_route_as_success(self):
        original_switch = self.runtime.switch
        for provider, model in [("custom:studio", "initial"), ("unexpected", "manual")]:
            def switch(**kwargs):
                result = original_switch(**kwargs)
                result.target_provider, result.new_model = provider, model
                return result
            self.runtime.switch = switch
            with self.assertRaises(module.ModelSelectionError) as error:
                self.service.set({"provider": "custom:studio", "model": "manual"})
            self.assertEqual(error.exception.code, 4304)
        self.assertNotIn(("persist",), self.runtime.calls)
        self.assertEqual(self.runtime.document, self.runtime.original)

    def test_gateway_registers_only_the_narrow_long_running_mutation(self):
        methods = {}
        server = SimpleNamespace(_LONG_HANDLERS=frozenset({"session.resume"}),
                                 register_method=lambda name, handler: methods.update({name: handler}),
                                 _ok=lambda rid, result: {"id": rid, "result": result},
                                 _err=lambda rid, code, message: {"id": rid, "error": {"code": code, "message": message}})
        module.install_model_rpc(server, self.service)
        self.assertEqual(set(methods), {"workbench.model.set"})
        self.assertEqual(server._LONG_HANDLERS, {"session.resume", "workbench.model.set"})
        response = methods["workbench.model.set"](1, {"provider": "custom:studio", "model": "manual"})
        self.assertEqual(response, {"id": 1, "result": {"provider": "custom:studio", "model": "manual"}})
        self.runtime.warning_value = object()
        response = methods["workbench.model.set"](2, {"provider": "custom:studio", "model": "costly"})
        self.assertEqual(response["error"]["code"], 4303)
        self.assertIn("native Hermes", response["error"]["message"])
        self.assertNotIn("fixture-secret", str(response))


if __name__ == "__main__":
    unittest.main()
