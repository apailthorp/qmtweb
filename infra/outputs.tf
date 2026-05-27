output "repo_full_name" {
  description = "owner/name of the managed repository."
  value       = github_repository.qmtweb.full_name
}

output "repo_html_url" {
  description = "HTML URL of the managed repository."
  value       = github_repository.qmtweb.html_url
}
