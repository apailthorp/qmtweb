variable "github_owner" {
  description = "GitHub user or org that owns the repo."
  type        = string
}

variable "repo_name" {
  description = "Name of the repository to manage."
  type        = string
  default     = "qmtweb"
}

variable "ftp_host" {
  description = "AccuWeb FTP hostname, e.g. ftp.pailthorp.net (FTPS on port 21)."
  type        = string
  sensitive   = true
}

variable "ftp_username" {
  description = "FTP account username, e.g. deploy@pailthorp.net."
  type        = string
  sensitive   = true
}

variable "ftp_password" {
  description = "Password for the deploy FTP account."
  type        = string
  sensitive   = true
}

variable "ftp_remote_dir" {
  description = "Server dir to deploy into, relative to the FTP account root. The deploy account is rooted at public_html, so this is usually './'."
  type        = string
  default     = "./"
}
