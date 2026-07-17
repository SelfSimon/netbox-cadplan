"""Pytest fixtures and lightweight Django/NetBox stubs for local development.

This file registers minimal `django.utils.translation` and `netbox.plugins`
modules in `sys.modules` so `netbox_plan` (and `netbox_plan.utils` in
particular, which imports `gettext` at module scope) can be imported and
tested without a full Django/NetBox installation.
"""

import sys
import types


def _ensure_module(name):
    if name in sys.modules:
        return sys.modules[name]
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


django = _ensure_module("django")
django_utils = _ensure_module("django.utils")
django_i18n = _ensure_module("django.utils.translation")
django_i18n.gettext = lambda s: s
django_i18n.gettext_lazy = lambda s: s

netbox = _ensure_module("netbox")
netbox_plugins = _ensure_module("netbox.plugins")


class _PluginConfig:
    pass


netbox_plugins.PluginConfig = _PluginConfig
