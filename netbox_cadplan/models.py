from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from netbox.models import NetBoxModel

from .choices import LengthUnitChoices, NamePositionChoices, ShapeChoices


class Plan(NetBoxModel):
    name = models.CharField(_("name"), max_length=100)
    site = models.ForeignKey(
        verbose_name=_("site"),
        to="dcim.Site",
        on_delete=models.PROTECT,
        related_name="plans",
    )
    location = models.ForeignKey(
        verbose_name=_("location"),
        to="dcim.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="plans",
    )
    dxf_file = models.FileField(_("DXF file"), upload_to="plans/dxf/")
    selected_layer = models.CharField(_("selected layer"), max_length=200, blank=True)
    width_px = models.PositiveIntegerField(default=1200)
    height_px = models.PositiveIntegerField(default=800)
    # Real-world scale of the plan (millimeters represented by one canvas pixel),
    # computed from the detected DXF unit ($INSUNITS) when zones are generated.
    # Allows converting the real dimensions (cm/inches) of a DeviceTypeShape/Rack
    # into pixels at the correct visual scale. Null if no layer has been confirmed
    # yet.
    mm_per_px = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "location"], name="unique_plan_site_location"
            ),
        ]

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("plugins:netbox_cadplan:plan", args=[self.pk])

    def clean(self):
        super().clean()
        if not self.site_id:
            return
        if self.location_id:
            if self.location.site_id != self.site_id:
                raise ValidationError(
                    {
                        "location": _(
                            "The selected location does not belong to the chosen site."
                        )
                    }
                )
            # Mutual exclusivity: no location plan if a whole-site plan
            # already exists.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=True)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "location": _(
                            "A plan covering the whole site already exists for this "
                            "site; a location plan cannot be created."
                        )
                    }
                )
        else:
            # UniqueConstraint(site, location) doesn't block two rows with
            # location=NULL for the same site (NULL != NULL in SQL), so we
            # enforce it explicitly here.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=True)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "site": _(
                            "A plan without a location (covering the whole site) "
                            "already exists for this site."
                        )
                    }
                )
            # Mutual exclusivity: no whole-site plan if location plans
            # already exist.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=False)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "site": _(
                            "Location plans already exist for this site; a site-wide "
                            "plan cannot be created."
                        )
                    }
                )


class PlanZone(NetBoxModel):
    plan = models.ForeignKey(
        to=Plan,
        on_delete=models.CASCADE,
        related_name="zones",
    )
    number = models.PositiveIntegerField()
    # OneToOne: a location can only correspond to a single zone of the plan.
    location = models.OneToOneField(
        to="dcim.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="plan_zone",
    )
    polygon_data = models.JSONField()
    # Raw polygon in native DXF units (before normalize_polygons), distinct from
    # polygon_data (pixel space, used for rendering). Serves as a stable reference to
    # detect whether this zone actually changed during a DXF reimport — comparing
    # polygon_data directly would be tripped up by a mere global shift/rescale of
    # all the layer's zones (see compute_transform()), unrelated to an actual
    # change to this room. Null for zones created before this field existed.
    source_polygon = models.JSONField(null=True, blank=True)
    svg_file = models.FileField(upload_to="plans/svg/", null=True, blank=True)
    label = models.CharField(max_length=100, blank=True)

    class Meta:
        ordering = ["plan", "number"]
        constraints = [
            models.UniqueConstraint(
                fields=["plan", "number"], name="unique_plan_zone_number"
            ),
        ]

    def __str__(self):
        if self.location:
            return f"Zone {self.number} ({self.location}) – {self.plan}"
        return f"Zone {self.number} – {self.plan}"

    def get_absolute_url(self):
        return reverse("plugins:netbox_cadplan:plan", args=[self.plan_id])


class DeviceTypeShape(NetBoxModel):
    """
    Graphical representation (shape + real dimensions) of a DeviceType on a plan.
    A Rack does not need this model: its dimensions come directly from
    dcim.Rack (outer_width/outer_depth/outer_unit).
    """

    device_type = models.OneToOneField(
        to="dcim.DeviceType",
        on_delete=models.CASCADE,
        related_name="plan_shape",
    )
    shape = models.CharField(
        max_length=20, choices=ShapeChoices, default=ShapeChoices.RECTANGLE
    )
    width = models.DecimalField(
        _("width"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    depth = models.DecimalField(
        _("depth"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    diameter = models.DecimalField(
        _("diameter"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    unit = models.CharField(
        _("unit"),
        max_length=10,
        choices=LengthUnitChoices,
        default=LengthUnitChoices.UNIT_CENTIMETER,
    )

    class Meta:
        ordering = ["device_type"]

    def __str__(self):
        return f"Forme de {self.device_type}"

    def get_absolute_url(self):
        return self.device_type.get_absolute_url()

    def clean(self):
        super().clean()
        if self.shape == ShapeChoices.RECTANGLE:
            if self.width is None or self.depth is None:
                raise ValidationError(
                    _("Width and depth are required for a rectangle.")
                )
        elif self.shape == ShapeChoices.CIRCLE:
            if self.diameter is None:
                raise ValidationError(_("Diameter is required for a circle."))


class PlacedObject(NetBoxModel):
    """
    Placement of a NetBox Device or Rack on a plan. `x`/`y` are expressed in the
    same global pixel space as PlanZone.polygon_data (see normalize_polygons()):
    the plan view displays them as-is, the location view applies the same offset
    as extract_zone_svg() to recenter them on the zone. A single database row
    serves both views, so they stay in sync automatically.
    """

    zone = models.ForeignKey(
        to=PlanZone,
        on_delete=models.CASCADE,
        related_name="placed_objects",
    )
    object_type = models.ForeignKey(
        to=ContentType,
        on_delete=models.CASCADE,
        limit_choices_to=Q(app_label="dcim", model__in=("device", "rack")),
    )
    object_id = models.PositiveBigIntegerField()
    content_object = GenericForeignKey("object_type", "object_id")
    x = models.FloatField()
    y = models.FloatField()
    # Degrees; relevant for rectangles only (ignored for circles).
    rotation = models.FloatField(default=0)
    snap_to_wall = models.BooleanField(default=False)
    # When True: the object is placed outside the zone's polygon, permanently
    # stuck against the nearest wall (slides along the perimeter when moved,
    # cannot detach from it) — mutually exclusive with snap_to_wall, which only
    # concerns optional magnetic snapping on the inside.
    outside_wall = models.BooleanField(default=False)
    name_position = models.CharField(
        max_length=10,
        choices=NamePositionChoices,
        default=NamePositionChoices.CENTER,
    )

    class Meta:
        ordering = ["zone", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["object_type", "object_id"],
                name="unique_placed_object_per_target",
            ),
        ]

    def __str__(self):
        return f"{self.content_object} @ {self.zone}"

    def get_absolute_url(self):
        return reverse("plugins:netbox_cadplan:plan", args=[self.zone.plan_id])
