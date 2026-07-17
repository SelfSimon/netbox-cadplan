# netbox-plan

NetBox plugin for visual floor-plan management. A plan is attached to a
NetBox `Site` (required) and, optionally, to a `Location` within that site,
based on an imported DXF/DWG file. The plan is split into zones associated
with locations (descendant Locations of the plan's Location, or the whole
site if no Location is specified), with the SVG of each location displayed
in a dedicated tab on its NetBox page.

## Compatibility

| Package | NetBox        | Python |
|---------|---------------|--------|
| 0.1.x   | 4.6.0 – 4.6.99 | ≥ 3.10 |

## Installation

### 1. Install the package

```bash
pip install netbox-plan
# or from source:
pip install git+https://github.com/simonlacroix/netbox-plan.git
```

### 2. Enable the plugin in NetBox

Add the plugin to `configuration.py` (or `configuration/plugins.py` depending
on your setup):

```python
PLUGINS = [
    # ... other plugins
    'netbox_plan',
]
```

### 3. Run migrations and restart NetBox

```bash
python manage.py migrate netbox_plan
sudo systemctl restart netbox netbox-rq
```

## Usage

- Import a DXF/DWG file to create a **Plan**, linked to a Site and optionally
  a Location.
- The plan is automatically split into **zones** matched to Locations
  descending from the plan's scope.
- Each Location gets a dedicated tab showing the SVG of its zone.
- Objects (device types with a configured plan shape) can be placed on a
  zone and repositioned interactively.
- Plans can be re-exported to DXF.

## License

MIT — see [LICENSE](LICENSE).

## Contributors

- [Simon Lacroix](https://github.com/simonlacroix) — Original author

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
