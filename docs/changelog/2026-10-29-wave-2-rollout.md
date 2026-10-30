# Wave 2 production recovery

Verified 2026-10-29 18:15 UTC.

The deployed build `d6c64e1cb28830e80d44ce05b8f47b7ec466fa2d` returned HTTP 503 from `/api/health` because production lacked the `workspaces.main_chat_name` column. All eight wave 2 migrations were absent from the production migration ledger. The migration step had been missed during merging.

Applied the chat migration first to restore health, then the other seven reviewed, merged migrations through the authenticated Supabase Management API. Each transaction also recorded the version, name and exact SQL in `supabase_migrations.schema_migrations` and notified PostgREST to reload its schema.

| Migration | Applied file SHA-256 |
|---|---|
| 20261103100100_user_chat_preferences.sql | `3dd6a75e7d58f1ca25b799ad3262a352cd8bec4913a47806ddd53fad47ea256d` |
| 20261103100000_workspace_chats.sql | `8bea6b2bb71188f52f4c11691987af8b6575a9464599d120babfa2b1f6ae3dc0` |
| 20261103110000_learnings.sql | `640a9d0fe109755e48c9c905a9c2bf4a0b5993ada1a628cab211da56239eb8fc` |
| 20261103111000_memories.sql | `5effba13ff9ea46e7cf6b4932df36e0ff7f8f9abe63ef1d037570bf792007c72` |
| 20261103130000_environment_skills.sql | `8103da69e9f2c4149fd0f7789772a47e604f11e34e71e4f3657e2ab1f02a9736` |
| 20261103131000_environment_mcp_servers.sql | `053033b6f00637e4278b6bdf23f007849320b45ca38108f741f9d9eb6223241b` |
| 20261103140000_secret_sync.sql | `030dfca067948f6b1bf9fdfd63076645079111bdd10b9662fb6a3586a8d8478a` |
| 20261103150000_workspace_previews.sql | `585cef6769a3045586d805e11df0d2702f44c0af6cf63eff41e5f9c68e5cf41d` |
| 20261103170000_media.sql | `88d5ff8684d6d0673e57cca8a8eb488f979ea45beac9afe37d989d042a326c8e` |

Verification:

- `/api/health`: HTTP 200, `ok=true`, `database.migrated=true`, intended build reported.
- All nine migration versions present in the production ledger. The final chat-preferences migration was applied immediately after #320 merged; RLS, authenticated CRUD, and service-role CRUD were verified.
- All ten new tables present, with RLS enabled and service-role read/write privileges.
- Media bucket private; file limit 52,428,800 bytes (50 MiB).
- Cloudflare deployment retry [40906644762](https://github.com/neevai-labs/outrunner/actions/runs/40906644762), attempt 2: SUCCESS.
- Desktop release [40905524884](https://github.com/neevai-labs/outrunner/actions/runs/40905524884): SUCCESS; the artifact-quota fix is verified.

Five automation checks remained in progress although their recorded runs were already refused with “Its session's setup never finished. Run it again.” Their recorded refusal reasons were queued as neutral “No review” outcomes through the existing check completion-retry fields. Their refused statuses were preserved; no successful reviews were fabricated. The normal application reconciler sent and confirmed all five outcomes on GitHub; their checks completed NEUTRAL.

Wave 2 code progress: **26/26 original PRs merged**, independently verified against GitHub. #319 merged as `4ddb39e784796dad4e3cf8187e6714a501c91027`; #320 merged as `8c6943362c29c9a80644e0568b73e1179b323d2a`. No wave 2 PR remains open. Supplemental fixes #326 and #327 are also merged.

Production serves current main `9557cf91e39d09d85e15ad32e0523f8e1c5aa6a0`, containing all wave 2 changes, independently verified at 18:15 UTC through `/api/health` (`ok=true`, `database.migrated=true`). Both #319 deployment [40916736853](https://github.com/neevai-labs/outrunner/actions/runs/40916736853) and final #320 deployment [40917737993](https://github.com/neevai-labs/outrunner/actions/runs/40917737993) succeeded. Latest main deployment [40919322873](https://github.com/neevai-labs/outrunner/actions/runs/40919322873) also succeeded. GitHub independently confirms all 26 cohort PRs are MERGED. Historical failed or cancelled deployment records do not change their merge state.

New review runs did not finish setup; earlier reviews of identical file trees remain the review evidence. Feature-level browser/agent tests were not repeated during this schema recovery. Preview activation and DNS remain pending the user's domain.
