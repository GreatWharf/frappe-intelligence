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
