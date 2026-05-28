terraform {
  required_version = ">= 1.6.0"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.3"
    }
  }
}

provider "github" {
  owner = var.github_owner
  # token is read from GITHUB_TOKEN env var
}

resource "github_repository" "qmtweb" {
  name         = var.repo_name
  description  = "Quick METAR and TAF plus weather links — pailthorp.net"
  visibility   = "public"
  homepage_url = "https://pailthorp.net"

  has_issues   = true
  has_wiki     = false
  has_projects = false

  allow_merge_commit     = false
  allow_squash_merge     = true
  allow_rebase_merge     = true
  delete_branch_on_merge = true

  # Avoid Terraform thinking it needs to re-init the repo on every plan.
  lifecycle {
    ignore_changes = [auto_init, gitignore_template, license_template]
  }
}

# Flow: feature → development (integration) → main (deploy).
# development is the default branch so new clones and PRs target it.
# Requires the `development` branch to already exist on the remote when
# this is applied — push it first, then `terraform apply`.
resource "github_branch_default" "default" {
  repository = github_repository.qmtweb.name
  branch     = "development"
}

resource "github_branch_protection" "main" {
  repository_id = github_repository.qmtweb.node_id
  pattern       = "main"

  required_status_checks {
    strict   = true
    contexts = ["test"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 0
    dismiss_stale_reviews           = true
  }

  enforce_admins      = false
  allows_force_pushes = false
  allows_deletions    = false
}

# development is the integration branch — feature PRs land here, then
# development → main is the deploy promotion. Same gates as main.
resource "github_branch_protection" "development" {
  repository_id = github_repository.qmtweb.node_id
  pattern       = "development"

  required_status_checks {
    strict   = true
    contexts = ["test"]
  }

  required_pull_request_reviews {
    required_approving_review_count = 0
    dismiss_stale_reviews           = true
  }

  enforce_admins      = false
  allows_force_pushes = false
  allows_deletions    = false
}

# --- Actions secrets used by .github/workflows/deploy.yml ---
# Values are supplied via Terraform variables (typically loaded from a
# gitignored terraform.tfvars). Never commit real secret values.
# Deploy is FTPS (port 21) to the AccuWeb FTP account.

resource "github_actions_secret" "ftp_host" {
  repository      = github_repository.qmtweb.name
  secret_name     = "FTP_HOST"
  plaintext_value = var.ftp_host
}

resource "github_actions_secret" "ftp_username" {
  repository      = github_repository.qmtweb.name
  secret_name     = "FTP_USERNAME"
  plaintext_value = var.ftp_username
}

resource "github_actions_secret" "ftp_password" {
  repository      = github_repository.qmtweb.name
  secret_name     = "FTP_PASSWORD"
  plaintext_value = var.ftp_password
}

resource "github_actions_secret" "ftp_remote_dir" {
  repository      = github_repository.qmtweb.name
  secret_name     = "FTP_REMOTE_DIR"
  plaintext_value = var.ftp_remote_dir
}
