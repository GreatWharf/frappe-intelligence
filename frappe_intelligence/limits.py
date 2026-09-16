"""Shared upload/read limits, independent of Frappe and the tool registry."""

MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def upload_limit_bytes(settings):
    """Return the configured MiB limit, defaulting to 10 and bounded to 1–20."""
    configured_mb = max(int(settings.get("max_upload_mb") or 10), 1)
    return min(configured_mb * 1024 * 1024, MAX_UPLOAD_BYTES)
