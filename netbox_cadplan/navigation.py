from django.utils.translation import gettext_lazy as _
from netbox.plugins import PluginMenu, PluginMenuButton, PluginMenuItem

plan_buttons = (
    PluginMenuButton(
        link="plugins:netbox_cadplan:plan_add",
        title=_("Add a plan"),
        icon_class="mdi mdi-plus-thick",
        permissions=["netbox_cadplan.add_plan"],
    ),
)

menu = PluginMenu(
    label="NetBox CadPlan",
    icon_class="mdi mdi-floor-plan",
    groups=(
        (
            _("Plans"),
            (
                PluginMenuItem(
                    link="plugins:netbox_cadplan:plan_list",
                    link_text=_("All plans"),
                    buttons=plan_buttons,
                    permissions=["netbox_cadplan.view_plan"],
                ),
            ),
        ),
    ),
)
