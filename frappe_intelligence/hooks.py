app_name = "frappe_intelligence"
app_title = "Intelligence"
app_publisher = "Great Wharf"
app_description = "Bring your own AI to Frappe with private chats and approved business tools"
app_email = "Merrick@greatwharf.com"
app_license = "MIT"
app_home = "/desk/intelligence-chat"
app_logo_url = "/assets/frappe_intelligence/images/intelligence.svg"

app_include_js = ["/assets/frappe_intelligence/js/intelligence.js"]
app_include_css = ["/assets/frappe_intelligence/css/intelligence.css"]

add_to_apps_screen = [
    dict(
        name=app_name,
        title=app_title,
        logo=app_logo_url,
        route=app_home,
        has_permission="frappe_intelligence.api.has_permission",
    )
]

before_install = "frappe_intelligence.install.before_install"
after_install = "frappe_intelligence.install.after_install"
after_migrate = "frappe_intelligence.install.after_migrate"
before_uninstall = "frappe_intelligence.install.before_uninstall"
scheduler_events = {"cron": {"*/2 * * * *": ["frappe_intelligence.engine.recover_runs"]}}

permission_query_conditions = {
    "Intelligence Conversation": "frappe_intelligence.permissions.conversation_query",
    "Intelligence Message": "frappe_intelligence.permissions.private_query",
    "Intelligence Run": "frappe_intelligence.permissions.private_query",
    "Intelligence Approval": "frappe_intelligence.permissions.private_query",
    "Intelligence Tool Execution": "frappe_intelligence.permissions.private_query",
    "Intelligence Provider": "frappe_intelligence.permissions.provider_query",
    "Intelligence Memory": "frappe_intelligence.permissions.memory_query",
}
has_permission = {
    "Intelligence Conversation": "frappe_intelligence.permissions.private_permission",
    "Intelligence Message": "frappe_intelligence.permissions.private_permission",
    "Intelligence Run": "frappe_intelligence.permissions.private_permission",
    "Intelligence Approval": "frappe_intelligence.permissions.private_permission",
    "Intelligence Tool Execution": "frappe_intelligence.permissions.private_permission",
    "Intelligence Provider": "frappe_intelligence.permissions.provider_permission",
    "Intelligence Memory": "frappe_intelligence.permissions.memory_permission",
}
doc_events = {"File": {"validate": "frappe_intelligence.files.guard_file"}}
