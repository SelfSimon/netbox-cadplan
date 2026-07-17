from netbox.plugins import PluginTemplateExtension


class DeviceTypePlanShapeExtension(PluginTemplateExtension):
    models = ["dcim.devicetype"]

    def right_page(self):
        request = self.context["request"]
        if not request.user.has_perm("netbox_plan.view_devicetypeshape"):
            return ""
        device_type = self.context["object"]
        shape = getattr(device_type, "plan_shape", None)
        return self.render(
            "netbox_plan/inc/devicetype_plan_shape_panel.html",
            extra_context={"shape": shape},
        )


template_extensions = [DeviceTypePlanShapeExtension]
