from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import PlanZone


@receiver(post_delete, sender=PlanZone)
def delete_orphaned_svg_file(instance, **kwargs):
    """
    Django never deletes a FileField's physical file when the instance is
    deleted (including on cascade, e.g. deleting a Plan which deletes its
    PlanZones). Without this signal, the SVG files generated on association
    would remain orphaned on disk.
    """
    if instance.svg_file:
        instance.svg_file.delete(save=False)
