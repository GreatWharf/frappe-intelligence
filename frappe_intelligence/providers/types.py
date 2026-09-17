"""Provider-neutral values. Deliberately independent of Frappe and provider SDKs."""

from dataclasses import dataclass, field


class ProviderError(Exception):
    """An error whose code and message are safe to return to the conversation owner."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass
class ProviderConfig:
    kind: str
    model: str
    api_key: str = field(repr=False)
    base_url: str = ""
    max_tokens: int = 4096
    timeout: int = 60
    allowed_hosts: tuple = ()
    # DocType Thinking Effort label (Low/Medium/High/Max); "" means Auto.
    effort: str = ""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict
    # Signatures are opaque server-owned continuation data, not UI/debug output.
    metadata: dict = field(default_factory=dict, repr=False)


@dataclass
class Reply:
    text: str
    tool_calls: list[ToolCall]
    usage: dict
