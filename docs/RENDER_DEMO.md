# Host the synthetic demo on Render Free and Atlas Free

The public demo uses one Render **Free** Docker web service, one MongoDB Atlas **Free (M0)** cluster, and Render's included HTTPS subdomain. Express serves the demo build and `/api/v1` on that same origin. This setup is intended to cost $0 within the free quotas. Keep both resources on **Free**, and skip paid add-ons and billing enrollment. [Render Free](https://render.com/docs/free) · [Atlas Free cluster setup](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/)

## 1. Review your GitHub branch

1. Run `git status --short` locally. Review and commit the deployment files on the branch you want to deploy, then push that branch yourself.
2. Connect a **private** GitHub repository to Render. The monorepo contains PIB pilot data and may contain other material you do not intend to publish in source form. The Docker build allowlist and final image include the API code, built frontend and fictional catalogue fixture. Keep ignored `.env` files, `.local`, database dumps, private information and any credentials out of Git. Render only needs access to the selected repository. If the source checkout itself must exclude the PIB files, use a separate private repository containing only approved demo sources. [Render GitHub integration](https://render.com/docs/git-provider)

## 2. Create the Atlas Free cluster and database user

1. Sign in to [MongoDB Atlas](https://cloud.mongodb.com/). Create a project named `BenefitBridge Demo` dedicated to this release.
2. In the project, go to **Project Overview → Create**. Select **Free (M0)** and name the cluster `benefitbridge-demo`. Choose Singapore if Atlas offers it for the selected Free provider, or the closest available Free region. Skip Atlas sample data. [Atlas cluster creation](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/)
3. In **Database & Network Access → Database Users**, create a password-authenticated database user such as `benefitbridge_demo_app`. Grant `readWrite` on the database **`benefitbridge_demo`** only. Use a database-scoped privilege or a custom role inheriting `readWrite` on that database, and remove any broader default role from the user. The database can remain empty until the first startup. [Atlas database users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/) · [Atlas custom roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/)
4. On the cluster, select **Connect → Drivers → Node.js**. Copy the `mongodb+srv://` connection string. Substitute the database username and password locally, percent-encoding reserved characters in the password. Leave the database path empty or use `/benefitbridge_demo`. Keep the driver’s `retryWrites=true`, `w=majority`, and optional `appName` settings. Store the completed URI only in your password manager and Render's environment settings. If Atlas asks for a network entry before showing the URI, add your current IP temporarily and remove it after setup. [Atlas connection strings](https://www.mongodb.com/docs/atlas/connect-your-application/) · [Atlas IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/)

Example shape using placeholders:

```text
mongodb+srv://<DB_USER>:<URL_ENCODED_PASSWORD>@<CLUSTER_HOST>/?retryWrites=true&w=majority&appName=benefitbridge-demo
```

## 3. Connect GitHub and create one Render Free service

1. Sign in to the [Render Dashboard](https://dashboard.render.com/). Choose **New → Blueprint**, connect GitHub, grant Render access to the reviewed repository, and select its deployment branch. Render reads [`render.yaml`](../render.yaml) from the repository root. Confirm the preview shows one **Free** Docker web service called `benefitbridge-demo`, with no Render database, disk, or worker. [Render Blueprint setup](https://render.com/docs/infrastructure-as-code)
2. When prompted for `DEMO_ATLAS_URI`, paste the complete Atlas URI into the secret value field and apply the Blueprint. If you create it manually instead, choose **New → Web Service → Git Provider**, select the same repository and branch, and use these settings. [Render Docker setup](https://render.com/docs/docker)

   | Setting | Value |
   | --- | --- |
   | Language / runtime | Docker |
   | Root directory | Leave blank for repository root |
   | Dockerfile path | `./Dockerfile` |
   | Instance type | Free |
   | Region | Singapore, or closest available to the Atlas cluster |
   | Docker command | Leave blank to use the Dockerfile command |
   | Health check path | `/api/v1/health` |
   | Auto-Deploy | Off |
   | Environment → Add Environment Variable | `DEMO_ATLAS_URI` with the private Atlas driver URI |

3. In the new Render service, open **Connect → Outbound** and copy its CIDR ranges. In Atlas, go to **Database & Network Access → IP Access List → Add IP Address** and add each of those ranges. Use the ranges shown for this service and keep the all-addresses entry `0.0.0.0/0` absent. Free-tier Render egress ranges are shared with other services in that region, so the scoped database credentials are still required. The first startup can fail while this list is empty. Once the Atlas entries are active, return to Render and choose **Manual Deploy → Deploy latest commit** if the service is still failing. [Render outbound IPs](https://render.com/docs/outbound-ip-addresses) · [Atlas IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/)
4. Render supplies `PORT`, `RENDER`, and `RENDER_EXTERNAL_URL`. Keep the included `onrender.com` origin for this release. The server reads that HTTPS origin for production security settings and starts the API on the assigned port. The hosted entry point enables no OAuth or email signup and starts no ingestion, notification, or Gemini workers. Keep real-data variables, OAuth secrets, Gemini keys, and private information out of the service environment. [Render environment variables](https://render.com/docs/environment-variables)

## 4. Verify the public URL

1. Open **Logs** in Render. Look for `Synthetic catalogue ready (13 seeded, 0 existing)` on a fresh database. On subsequent starts expect `0 seeded, 13 existing`. Check that the service becomes healthy. The startup seed uses the built-in fictional fixture and reuses existing records and versions. A database containing authorized catalogue data fails startup. [Render health checks](https://render.com/docs/health-checks)
2. Replace the hostname below with your Render URL. The health response should be `{"status":"ok","dataset":"synthetic"}`. The default list initially has 12 visible records because one seeded fixture is closed. An unknown API route should return a JSON 404.

   ```powershell
   curl.exe -fsS https://benefitbridge-demo.onrender.com/api/v1/health
   curl.exe -fsS "https://benefitbridge-demo.onrender.com/api/v1/schemes?limit=1"
   curl.exe -i https://benefitbridge-demo.onrender.com/api/v1/unknown
   ```

3. On desktop and a phone, open the HTTPS site and check the fictional-data banner. Search for `solar`, filter by Maharashtra, open the matching scheme and reload its direct URL. Try guest personalization and reset, and confirm fictional listings have no real application link. Try `/account` and `/admin` to confirm SPA routing works and guest access to protected APIs is denied. The public demo is guest-first. Use the local demo to show bookmarks, saved profiles, authenticated notifications, and administrative review.
4. Check the `RateLimit` remaining count for a catalogue request from two independent network connections, such as home Wi-Fi and cellular, during the same minute. They should have separate counters through Render's normal ingress. The app trusts the immediate Render proxy hop and limits requests in memory, so counters reset when the instance restarts. The startup, proxy and cookie behavior on the real host still needs this live check. [Render client IP guidance](https://render.com/articles/how-render-handles-ddos-attacks)

## Free-tier limits and rollback

- Render Free sleeps after 15 minutes of inactivity. The next visitor can wait roughly a minute for startup. The filesystem is ephemeral. Atlas holds application state, and the startup seed requires no local files beyond those packaged in the image. Render provides 750 free instance hours per workspace per month plus separate bandwidth and build allowances. [Render Free limits](https://render.com/docs/free)
- Atlas Free limits storage to 512 MB and concurrent connections to 500, throttles high usage, and can pause after 30 days without connections. The hosted app uses a pool capped at 10 connections per server. If Atlas is paused, resume it before the demo and redeploy Render if it fails to recover. [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
- If a release fails, open **Events** in Render and roll back to a prior healthy deploy, or manually deploy the last known-good Git commit. Free services retain two previous deploys for dashboard rollback. Keep the Atlas database and environment settings in place, then repeat the health, catalogue and mobile checks. A Render rollback changes the application release. It does not restore MongoDB. [Render rollback](https://render.com/docs/rollbacks)

Local commands such as `npm.cmd run demo:api`, `npm.cmd run demo:web`, and `npm.cmd run seed:demo` still use local MongoDB. `DEMO_ATLAS_URI` is only used by the hosted `--render-demo` mode.
