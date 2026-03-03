### 2026-03-03: Gitflow friction — pending decision

**By:** Michael Brown (via Copilot)  
**What:** Michael noted that the gitflow pattern (feature/* → dev → main) doesn't work well with how the squad works. No specific change directed yet — needs confirmation.  
**Context:**  
- 4 open feature branches (#94–#97) all targeting `dev`
- `dev` → `main` is a second gate before any deploy
- For a small team with AI agents, this adds friction without clear benefit

**Options on the table:**  
1. **GitHub Flow** (recommended) — feature branches → `main` directly, no `dev`. Retarget all 4 PRs. Delete `dev` after.
2. **Keep gitflow** — status quo, but limit WIP to 1-2 branches at a time to reduce queue buildup.
3. **Trunk-based** — work directly on `main` or ultra-short branches (< 1 day). Requires feature flags.

**Recommendation:** GitHub Flow. Simpler, no integration bottleneck, fits the current team size and pace.  
**Status:** Waiting for Michael to confirm before any branch retargeting.
