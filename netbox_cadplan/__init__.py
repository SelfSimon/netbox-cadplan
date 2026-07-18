try:
    from netbox.plugins import PluginConfig
except Exception:
    # Minimal fallback for local development / tests when NetBox is not
    # available. This avoids import-time errors during pytest collection.
    class PluginConfig:  # type: ignore
        pass


class NetBoxCadPlanConfig(PluginConfig):
    name = "netbox_cadplan"
    verbose_name = "NetBox CadPlan"
    description = "Visual floor-plan management linked to Sites and Locations"
    version = "0.2.0"
    author = "Simon Lacroix"
    author_email = "simonlacroix@live.ca"
    base_url = "cadplan"
    min_version = "4.6.0"
    max_version = "4.6.99"
    required_settings = []
    default_settings = {}

    def ready(self):
        super().ready()
        from . import signals  # noqa: F401


config = NetBoxCadPlanConfig
