"""Narrow model selection bridge; Hermes owns routing, validation and persistence.

No config/auth content is returned. Dependencies are lazy and injectable so tests
never import Hermes, read user configuration, or send model requests.
"""
from __future__ import annotations

import threading


class ModelSelectionError(ValueError):
    def __init__(self, code=4302):
        self.code = code
        super().__init__("Hermes model selection was not confirmed.")


def _text(value, limit):
    return (isinstance(value, str) and bool(value.strip()) and len(value.strip()) <= limit
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


class _HermesRuntime:
    def inventory(self):
        from hermes_cli.inventory import build_model_options_payload, load_picker_context
        return build_model_options_payload(load_picker_context(), explicit_only=True, include_unconfigured=False)

    def config(self):
        from hermes_cli.config import load_config
        return load_config()

    def custom_providers(self, config):
        from hermes_cli.config import get_compatible_custom_providers
        return get_compatible_custom_providers(config)

    def switch(self, **kwargs):
        from hermes_cli.model_switch import switch_model
        return switch_model(**kwargs)

    def warning(self, result):
        from hermes_cli.model_selection_guards import combined_selection_warning
        return combined_selection_warning(result.new_model, provider=result.target_provider,
                                          base_url=result.base_url, api_key=result.api_key,
                                          model_info=result.model_info)

    def persist(self, result):
        from hermes_cli.model_switch import persist_model_selection
        persist_model_selection(result)


class HermesModelSelection:
    def __init__(self, runtime=None):
        self.runtime = runtime or _HermesRuntime()
        self.lock = threading.RLock()

    def set(self, params):
        if (not isinstance(params, dict) or set(params) != {"provider", "model"}
                or not _text(params.get("provider"), 128) or not _text(params.get("model"), 256)):
            raise ModelSelectionError(4300)
        provider, model = params["provider"].strip(), params["model"].strip()
        with self.lock:
            try:
                inventory = self.runtime.inventory()
                rows = inventory.get("providers") if isinstance(inventory, dict) else None
                if not isinstance(rows, list):
                    raise ModelSelectionError()
                matches = [row for row in rows if isinstance(row, dict) and row.get("slug") == provider]
                if len(matches) != 1 or matches[0].get("authenticated") is not True:
                    raise ModelSelectionError(4301)
                config = self.runtime.config()
                model_config = config.get("model") if isinstance(config.get("model"), dict) else {}
                result = self.runtime.switch(
                    raw_input=model, explicit_provider=provider, is_global=True,
                    current_provider=str(model_config.get("provider") or ""),
                    current_model=str(model_config.get("default") or ""),
                    current_base_url=str(model_config.get("base_url") or ""), current_api_key="",
                    user_providers=config.get("providers") if isinstance(config.get("providers"), dict) else {},
                    custom_providers=self.runtime.custom_providers(config))
                if not result.success or not _text(result.target_provider, 128) or not _text(result.new_model, 256):
                    raise ModelSelectionError()
                if result.target_provider != provider or result.new_model != model:
                    raise ModelSelectionError(4304)
                if self.runtime.warning(result) is not None or result.warning_message:
                    raise ModelSelectionError(4303)
                self.runtime.persist(result)
                actual = self.runtime.inventory()
                if actual.get("provider") != result.target_provider or actual.get("model") != result.new_model:
                    raise ModelSelectionError(4304)
                return {"provider": result.target_provider, "model": result.new_model}
            except ModelSelectionError:
                raise
            except Exception:
                raise ModelSelectionError() from None


def install_model_rpc(server, service=None):
    service = service or HermesModelSelection()

    def set_model(rid, params):
        try:
            return server._ok(rid, service.set(params))
        except ModelSelectionError as error:
            message = ("Choose this model in native Hermes to review its selection warning, then refresh."
                       if error.code == 4303 else "Hermes model selection was not confirmed; refresh the current choice.")
            return server._err(rid, error.code, message)

    server.register_method("workbench.model.set", set_model)
    server._LONG_HANDLERS = frozenset(server._LONG_HANDLERS) | {"workbench.model.set"}
    return service
