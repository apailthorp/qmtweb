# infra/

Terraform-managed configuration for the `qmtweb` GitHub repository.

## Scope (and what is NOT managed here)

This Terraform config uses [`integrations/github`](https://registry.terraform.io/providers/integrations/github/latest)
to manage:

- The `qmtweb` GitHub repository (settings, merge rules)
- Branch protection on `main`
- Actions secrets used by `.github/workflows/deploy.yml` for SFTP deploys

**Not managed by Terraform** (no provider exists for these):

- AccuWeb Hosting itself — the LiteSpeed server, cPanel account, webroot.
- DNS for `pailthorp.net`, which is on AccuWeb's nameservers
  (`hl1/hl2.cloudhostingforlinux.com`). DNS records are edited manually
  in the AccuWeb / cPanel UI.

If DNS is later moved to a provider that has a Terraform integration
(Cloudflare, Route 53, etc.), that can be added here as a second
provider block.

## Bootstrap

1. Create a GitHub personal access token (classic, scope: `repo`,
   `admin:repo_hook`, `delete_repo` if you ever want to destroy).
   Export it:

   ```sh
   export GITHUB_TOKEN=ghp_...
   ```

2. Copy the example tfvars and fill in real values:

   ```sh
   cp terraform.tfvars.example terraform.tfvars
   # then edit terraform.tfvars
   ```

   `terraform.tfvars` is gitignored — never commit it.

3. Run Terraform:

   ```sh
   terraform init
   terraform plan
   terraform apply
   ```

## Rotating the SFTP key

Update `sftp_private_key` in `terraform.tfvars` and `terraform apply`.
The Actions secret is updated in place; the next deploy uses the new key.
