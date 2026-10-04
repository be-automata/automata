production-validator (somnio-engineering-ai) — PR #229, ENV automata-exec-1, BUILD 5f9a6d47
VERDICT: PASS_WITH_WARNINGS (lens: code + infrastructure)
V-1 LOW: worker spawns /opt/automata-platform/packages/daemon/dist/index.js (WORKER_DAEMON_DIST unset -> defaultDaemonDist, config.ts:437); /usr/local/automata/daemon/index.js is a byte-identical staged copy (same sha256 1fa56b3a0ff7...c3a9). Behaviour identical.
V-2 INFO: worker journal does not label the lane of each of the 12 post-deploy runs. Closed by correlation in this UAT: every run produced a formal bot review (APPROVED/CHANGES_REQUESTED/DISMISSED), which only the review lane's single-writer executor posts.
V-3 INFO: scanner hits mockSuccessResult/getMockSuccessResult in daemon.ts are a pre-existing adapter capability, not in the diff; added lines have zero hits (scanner proven on a planted marker).
Code lens: no mock/stub/TODO/not-implemented in the delivered path; isCredentialGitConfigKey + rewritten stripGithubCredentials wired at daemon.ts:608.
Infra lens: box HEAD 5f9a6d47; bundle contains isCredentialGitConfigKey (def line 6595, call 6620, call site 7027); bundle rebuilt at worker start 17:16:31-33; NRestarts=0; 12 daemon spawns, 0 dubious/safe.directory journal lines.
