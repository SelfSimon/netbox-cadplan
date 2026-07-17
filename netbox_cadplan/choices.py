from django.utils.translation import gettext_lazy as _
from utilities.choices import ChoiceSet


class ShapeChoices(ChoiceSet):

    RECTANGLE = "rectangle"
    CIRCLE = "circle"

    CHOICES = (
        (RECTANGLE, _("Rectangle")),
        (CIRCLE, _("Circle")),
    )


class LengthUnitChoices(ChoiceSet):

    UNIT_CENTIMETER = "cm"
    UNIT_INCH = "in"

    CHOICES = (
        (UNIT_CENTIMETER, _("Centimeters")),
        (UNIT_INCH, _("Inches")),
    )


class NamePositionChoices(ChoiceSet):

    TOP = "top"
    BOTTOM = "bottom"
    LEFT = "left"
    RIGHT = "right"
    CENTER = "center"

    CHOICES = (
        (TOP, _("Top")),
        (BOTTOM, _("Bottom")),
        (LEFT, _("Left")),
        (RIGHT, _("Right")),
        (CENTER, _("Center")),
    )
