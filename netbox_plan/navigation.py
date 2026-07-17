from django.utils.translation import gettext_lazy as _
from netbox.plugins import PluginMenu, PluginMenuButton, PluginMenuItem

plan_buttons = (
    PluginMenuButton(
        link="plugins:netbox_plan:plan_add",
        title=_("Ajouter un plan"),
        icon_class="mdi mdi-plus-thick",
        permissions=["netbox_plan.add_plan"],
    ),
)

menu = PluginMenu(
    label="NetBox Plan",
    icon_class="mdi mdi-floor-plan",
    groups=(
        (
            _("Plans"),
            (
                PluginMenuItem(
                    link="plugins:netbox_plan:plan_list",
                    link_text=_("Tous les plans"),
                    buttons=plan_buttons,
                    permissions=["netbox_plan.view_plan"],
                ),
            ),
        ),
    ),
)
