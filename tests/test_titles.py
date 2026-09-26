"""Generated conversation titles: strict prompt, slop rejection and validation."""

from test_engine_state import env as env
from test_engine_state import reply
from test_grants_and_titles import submit_titled, title_reply, use_real_config


def test_greeting_slop_is_rejected_and_the_placeholder_stays(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "hi")
    slop = "Hi there, how can I help you today?"
    env.replies.append(reply(text=slop))
    env.replies.append(title_reply(slop))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "hi", "the echoed assistant greeting never becomes the title"


def test_access_disclaimer_slop_is_rejected(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "Check the Acme Corp bank balance")
    slop = "Hi there, just to clarify, I don't have access the ability to check balances."
    env.replies.append(reply(text=slop))
    env.replies.append(title_reply(slop))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Check the Acme Corp bank balance"


def test_a_descriptive_title_is_saved(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "What is our cash position this quarter?")
    env.replies.append(reply(text="Your cash position across the three accounts is 4.2M."))
    env.replies.append(title_reply("Quarterly cash position review"))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Quarterly cash position review"


def test_an_overlong_title_is_truncated_to_the_cap(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    candidate = "Review " + "x" * 200
    env.replies.append(reply(text="Answer."))
    env.replies.append(title_reply(candidate))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == candidate[:100]
    assert len(doc.title) == 100


def test_a_rename_during_the_title_call_blocks_the_replacement(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    env.replies.append(reply(text="Answer."))

    def renamed_inflight():
        doc = env.frappe.get_doc("Intelligence Conversation", "titled")
        doc.update(title="Named by hand", title_manually_set=1)
        env.frappe.db.commit()
        return title_reply("Quarterly cash position review")

    env.replies.append(renamed_inflight)
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Named by hand", "a concurrent manual rename always wins"


def test_the_reply_is_labeled_context_and_cannot_leak_into_the_title(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env)
    slop = "Sure! Your invoices look healthy overall."
    env.replies.append(reply(text=slop))
    env.replies.append(title_reply(slop))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Show my unpaid invoices", "the reply echo is rejected"
    payload = env.calls[-1][-1]["content"]
    assert "User message:\nShow my unpaid invoices" in payload
    assert f"Assistant reply (context only):\n{slop}" in payload, (
        "the reply still reaches the model, labeled as context only"
    )


def test_clean_title_validation_rules(env):
    clean = env.engine._clean_title
    for slop in (
        "Hi there, how can I help you today?",
        "Hello! How may I assist?",
        "Greetings, how can I help you today?",
        "Welcome! What would you like to do?",
        "Sure, happy to help with that",
        "Of course, let me know what you need",
        "I'm afraid I don't have access to that",
        "As an AI I cannot check balances",
        "Great, thanks for asking",
        "Thank you, I can't do that",
        "What would you like to review?",
        "ok",
        "",
        None,
    ):
        assert clean(slop) == "", slop
    assert clean('  "Quarterly cash position review."\n') == "Quarterly cash position review"
    assert clean("T" * 150) == "T" * 100


def test_clean_title_rejects_product_framing_the_user_never_named(env):
    clean = env.engine._clean_title
    # Invented product framing is assistant slop: reject it even when the
    # candidate is otherwise well-formed.
    assert clean("Greetings and ERPNext assistance", "hi") == ""
    assert clean("ERPNext assistance overview", "What can you do?") == ""
    assert clean("Your Frappe Intelligence briefing", "check my invoices") == ""
    assert clean("Assistant capabilities summary", "hi") == ""
    # A term the user's own first message names is fine to echo back.
    assert clean("ERPNext invoice review", "Show my ERPNext invoices") == "ERPNext invoice review"
    assert clean("Frappe upgrade plan", "plan the Frappe upgrade") == "Frappe upgrade plan"


def test_small_talk_keeps_the_placeholder_and_never_calls_the_provider(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "hi")
    env.replies.append(reply(text="Hi there! How can I help you today?"))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "hi", "the user's own words stay as the title"
    assert len(env.calls) == 1, "no provider round-trip is spent titling a greeting"


def test_a_two_word_greeting_also_skips_the_title_call(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "Good morning!")
    env.replies.append(reply(text="Good morning! What can I do for you?"))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Good morning!"
    assert len(env.calls) == 1


def test_invented_product_framing_is_rejected_even_when_returned(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "What can you do?")
    env.replies.append(reply(text="I can read records and draft changes you approve."))
    env.replies.append(title_reply("Greetings and ERPNext assistance"))
    env.engine.process_run(name)
    assert env.engine.get_run(name)["state"] == "completed"
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "What can you do?", "invented product framing never becomes the title"


def test_a_product_term_the_user_named_may_stay_in_the_title(env, monkeypatch):
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "Show my ERPNext invoices")
    env.replies.append(reply(text="Here are your unpaid invoices."))
    env.replies.append(title_reply("ERPNext invoice review"))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "ERPNext invoice review"


def test_a_question_form_candidate_lands_as_a_statement(env, monkeypatch):
    """A title phrased as the user's question is fine once the '?' is stripped."""
    use_real_config(env, monkeypatch)
    name = submit_titled(env, "Which customers owe us the most?")
    env.replies.append(reply(text="Acme Corp leads, followed by Northstar."))
    env.replies.append(title_reply("Which customers owe us the most?"))
    env.engine.process_run(name)
    doc = env.frappe.get_doc("Intelligence Conversation", "titled")
    assert doc.title == "Which customers owe us the most"


def test_runtime_token_cap_is_1048576_with_a_32768_fallback(env):
    # Runtime clamp in get_provider_config; test_engine_provider_config.py pins
    # the wire boundary, so this lives with the engine-level title/config tests.
    provider = env.frappe.get_doc("Intelligence Provider", "provider")
    provider.max_tokens = 1048576
    env.frappe.settings.max_tokens = 1048576
    assert env.engine.get_provider_config("provider").max_tokens == 1048576
    provider.max_tokens = 5000000
    assert env.engine.get_provider_config("provider").max_tokens == 1048576, "the ceiling clamps"
    provider.max_tokens = None
    env.frappe.settings.max_tokens = None
    assert env.engine.get_provider_config("provider").max_tokens == 32768, "unset limits fall back"
