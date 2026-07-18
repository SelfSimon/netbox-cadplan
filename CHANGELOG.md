# Changelog

All notable changes to this project will be documented in this file.

## 0.2.1

- Fix README compatibility table, contributors section, and source install
  URL; expand the feature list (docs only, no code change).

## 0.2.0

- Add "Position by distance" tool and object selection highlighting on the
  plan canvas.
- Add Center view control, fit-to-view canvas sizing, and pickable-list
  refresh.
- Theme-aware label colors on canvas.
- Cache parsed DXF documents and only list layers with geometry, for faster
  layer selection.
- Replace the layer selection list with a searchable dropdown with a loading
  state.
- Link to device type shape configuration directly from unplaceable devices.
- Switch the default UI to English, with French available as a translation.
- Fix Properties panel not refreshing after right-click rotate on a selected
  object.

## 0.1.0

- Initial release: import DXF/DWG plans linked to Sites and Locations.
- Automatic zone splitting matched to descendant Locations, with per-location
  SVG display tab.
- Device type plan shapes and interactive object placement on zones.
- DXF re-export.
