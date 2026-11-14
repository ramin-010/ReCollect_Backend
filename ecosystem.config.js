module.exports = {
    apps: [
        {
            name: "second-brain-api",
            script: "./dist/index.js",
            watch: false,
            env_file: ".env",
            env: {
                NODE_ENV: "development"
            },
            env_production: {
                NODE_ENV: "production"
            }
        }
        // The BullMQ "second-brain-worker" (dist/worker/reminderWorker.js) was removed: it only
        // delivered legacy Content reminders (cut). Reminders are sent by the in-process cron, and
        // the BullMQ/Redis mode (USE_BULLMQ) is gone.
    ]
};
