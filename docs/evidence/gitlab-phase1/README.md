# GitLab Phase 1 visual evidence

Real dsh-superagent panel captures, 1280×900 viewport, light theme, taken from two separate DSH profiles that run the
same fake GitHub repository and fake GitLab project settings. The sidebar is cropped out; the application content is not
otherwise edited. The credentials are placeholders (`owner/name`, `group/project`, `gitlab.example.com`); no real token or
private Feishu content appears.

- **Before** — the commit this branch started from, `f3ab960` (`git worktree` of that commit, profile `gitlab-before`, port 3098).
- **After** — this branch's built working tree, profile `gitlab-after`, port 3099, with the GitLab plugin enabled.
- **Plugin config** — `Plugins > Superagent > Configure`: the Before page has no GitLab row; the After page shows the GitLab
  instance and commit email beside the repository and agent account.
- **Sources** — `Superagent > Settings > Sources`: the Before page shows GitLab as "Plugin not installed" while its saved
  configuration is retained; the After page shows the GitLab Source card with its project, account, token-file check,
  own-account switch and its hint that unmentioned content becomes inferred candidates.

The screenshots were captured with Playwright/Chromium against the running applications. They are evidence for the UI
change only; they do not demonstrate live GitLab API behaviour.
