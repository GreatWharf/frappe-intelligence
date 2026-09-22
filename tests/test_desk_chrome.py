"""Guards that shipped CSS never hides native Desk chrome.

The 0.7.x line replaced every custom panel with the platform's own sidebar,
share, search and lists. A leftover rule once set `display: none` on
`.body-sidebar-top` while the app was open, which blanked the whole native
workspace sidebar (and hid the Recent chats section with it). These checks
read the real stylesheets and fail if any rule hides native sidebar regions
again. They deliberately allow hiding things inside the app's own `.fi-*`
surfaces and the workspace header avatar swap in fi/panel.css.
"""

import re
from pathlib import Path

CSS_DIR = Path(__file__).resolve().parent.parent / "frappe_intelligence" / "public" / "css"

# Native sidebar regions that must stay visible: the scrollable nav and the
# item tree inside it. Hiding these removes the workspace's own navigation.
PROTECTED_REGIONS = (".body-sidebar-top", ".sidebar-items")

RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")
DISPLAY_NONE = re.compile(r"display\s*:\s*none")


def test_no_rule_hides_the_native_sidebar_regions():
    offenders = []
    for sheet in sorted(CSS_DIR.rglob("*.css")):
        for selector, body in RULE.findall(sheet.read_text()):
            if not DISPLAY_NONE.search(body):
                continue
            for region in PROTECTED_REGIONS:
                if region in selector:
                    offenders.append(f"{sheet.name}: `{selector.strip()}` hides {region}")
    assert not offenders, "CSS rules hiding native Desk sidebar regions:\n" + "\n".join(offenders)
