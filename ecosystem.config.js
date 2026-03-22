module.exports = {
    apps: [
        {
            name: "second-brain-api",
            script: "./dist/index.js",
            watch: false,
            env_file: ".env",
            env: {
                NODE_ENV: "development",
                USE_BULLMQ: "false"
            },
            env_production: {
                NODE_ENV: "production",
                USE_BULLMQ: "false"
            }
        },
        {
            name: "second-brain-worker",
            script: "./dist/worker/reminderWorker.js",
            watch: false,
            env_file: ".env",
            env: {
                NODE_ENV: "development",
                USE_BULLMQ: "false"
            },
            env_production: {
                NODE_ENV: "production",
                USE_BULLMQ: "false"
            }
        }
    ]
};
