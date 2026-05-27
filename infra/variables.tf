variable "github_owner" {
  description = "GitHub user or org that owns the repo."
  type        = string
}

variable "repo_name" {
  description = "Name of the repository to manage."
  type        = string
  default     = "qmtweb"
}

variable "sftp_host" {
  description = "AccuWeb SFTP hostname (e.g. server NN.accuwebhosting.com)."
  type        = string
  sensitive   = true
}

variable "sftp_port" {
  description = "SFTP port. AccuWeb typically uses 22."
  type        = string
  default     = "22"
}

variable "sftp_username" {
  description = "SFTP username (your AccuWeb / cPanel user)."
  type        = string
  sensitive   = true
}

variable "sftp_private_key" {
  description = "PEM-encoded SSH private key authorized for SFTP_USERNAME on the AccuWeb host."
  type        = string
  sensitive   = true
}

variable "sftp_remote_path" {
  description = "Webroot on AccuWeb to deploy into, e.g. /home/USER/public_html"
  type        = string
  sensitive   = true
}
