Release checklist
=================

This document describes the minimal steps to create a release and publish
to TestPyPI/PyPI.

1. Bump version
   - Update `version` in `pyproject.toml` (e.g. `0.1.0 -> 0.1.1`).
   - Update `version` in `netbox_plan/__init__.py` (`NetBoxPlanConfig.version`) to match.
   - Update `CHANGELOG.md` with release notes.

2. Run tests and linters locally

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
ruff check .
black --check .
pytest -q
```

3. Build distributions

```powershell
python -m build
# artifacts are in dist/
```

4. Upload to TestPyPI (recommended first)

```powershell
$env:TWINE_USERNAME = '__token__'
$env:TWINE_PASSWORD = '<TEST_PYPI_TOKEN>'
python -m twine upload --repository testpypi dist/*
Remove-Item Env:TWINE_USERNAME; Remove-Item Env:TWINE_PASSWORD
```

5. Install from TestPyPI to validate

```powershell
pip install --index-url https://test.pypi.org/simple/ --no-deps netbox-plan==X.Y.Z
```

6. Publish to PyPI

If you use the repository GitHub Actions `publish` workflow, uploading to
PyPI is performed automatically when you push a `v*` tag. In that case you
do not need to run the `twine upload` command locally — use the CI instead.

If you prefer to publish manually instead of using CI, use the commands
below (requires a PyPI API token):

```powershell
$env:TWINE_USERNAME = '__token__'
$env:TWINE_PASSWORD = '<PYPI_TOKEN>'
python -m twine upload dist/*
Remove-Item Env:TWINE_USERNAME; Remove-Item Env:TWINE_PASSWORD
```

7. Tag & push

```powershell
git tag vX.Y.Z
git push origin --tags
```

8. Create GitHub release (optional)

- Create a release on GitHub matching the tag and paste the changelog notes.

CI / GitHub Actions
-------------------

This repository includes a `publish` workflow that will build and publish
the package when a tag matching `v*` is pushed, or when you trigger the
workflow manually.

- Repository secrets/environments required:
   - Either `PYPI_API_TOKEN` / `TEST_PYPI_TOKEN` as repository secrets, or
     Trusted Publishing (OIDC) configured on PyPI/TestPyPI for this
     repository, mapped to the `pypi` / `testpypi` GitHub environments.
   - Trusted Publishing must be set up manually on pypi.org / test.pypi.org
     (Project → Publishing → Add a new publisher) before the first tag push,
     pointing at this repository, the `publish.yml` workflow, and the
     matching environment name.

- To publish automatically: bump the version, commit, tag and push the tag:

```powershell
git tag vX.Y.Z
git push origin --tags
```

- To publish manually (TestPyPI) from the Actions UI: Actions → Publish Python Package → Run workflow → set `repository=testpypi` and run.

- Verify run: open the workflow run in GitHub Actions and inspect the `publish` job logs. If the job fails, the logs include the `twine`/upload output and HTTP response from PyPI/TestPyPI.

Notes
-----
- The workflow performs linting, tests and builds before publishing. Ensure the tag points to the commit that has the bumped `version` and updated `CHANGELOG.md`.
- Keep tokens in GitHub secrets only. Do not hardcode them in files or the repository.
- Always use API tokens (username `__token__`) if not using Trusted Publishing.
- Verify `MANIFEST.in` and `tool.setuptools.package-data` include templates/static/locale files.
