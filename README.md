# netbox-cadplan

NetBox plugin for visual floor-plan management. A plan is attached to a
NetBox `Site` (required) and, optionally, to a `Location` within that site,
based on an imported DXF/DWG file. The plan is split into zones associated
with locations (descendant Locations of the plan's Location, or the whole
site if no Location is specified), with the SVG of each location displayed
in a dedicated tab on its NetBox page.

## Compatibility

| Package | NetBox        | Python |
|---------|---------------|--------|
| 0.2.x   | 4.6.0 – 4.6.99 | ≥ 3.10 |
| 0.1.x   | 4.6.0 – 4.6.99 | ≥ 3.10 |

## Installation

### 1. Install the package

```bash
pip install netbox-cadplan
# or from source:
pip install git+https://github.com/SelfSimon/netbox-cadplan.git
```

### 2. Enable the plugin in NetBox

Add the plugin to `configuration.py` (or `configuration/plugins.py` depending
on your setup):

```python
PLUGINS = [
    # ... other plugins
    'netbox_cadplan',
]
```

### 3. Run migrations and restart NetBox

```bash
python manage.py migrate netbox_cadplan
sudo systemctl restart netbox netbox-rq
```

## Usage

- Import a DXF/DWG file to create a **Plan**, linked to a Site and optionally
  a Location, and pick the drawing layer that defines the floor's closed
  boundaries.
- The plan is automatically split into **zones** matched to Locations
  descending from the plan's scope. Each zone can be associated with a
  Location from the plan's own tab.
- Each Location gets a dedicated tab showing the SVG of its zone.
- **Object placement**: device types with a configured plan shape appear in
  an "Objects to place" list and can be dropped onto a zone, then dragged,
  rotated, and repositioned interactively on the canvas.
- **Position by distance**: move a placed object to an exact offset instead
  of dragging it by hand.
- Selecting an object highlights it and shows its properties (location,
  rotation, distances) in a side panel.
- **Center view** / fit-to-view controls keep the canvas readable regardless
  of the plan's real-world size, with theme-aware colors for labels.
- Plans can be **re-exported to DXF** once zones and layer selection are set.

## Configuring device type plan shapes

To make a device type placeable on a plan, configure its shape (width,
height, rotation handling) from the device type's edit page — devices
without a configured shape show up as "unplaceable" in the plan editor with
a direct link to that configuration screen.

## License

MIT — see [LICENSE](LICENSE).

## Contributors

See [CONTRIBUTORS.md](CONTRIBUTORS.md).

## Developer setup

Quick setup for contributors — creates a virtualenv, installs development
dependencies and installs the `pre-commit` git hooks.

PowerShell (Windows):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -e ".[dev]"
pre-commit install
pre-commit run --all-files
```

POSIX (macOS / Linux):

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e '.[dev]'
pre-commit install
pre-commit run --all-files
```

If you prefer automation, run `scripts/bootstrap.ps1` on Windows or
`scripts/bootstrap.sh` on POSIX systems to perform these steps.
