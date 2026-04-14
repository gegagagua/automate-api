/**
 * ლოკალური განვითარება (APP_ENV არ არის prod / NODE_ENV !== production)
 * env უპირატესია: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 */
const defaults = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "finance",
};

export default {
  host: process.env.DB_HOST ?? defaults.host,
  port: Number(process.env.DB_PORT ?? defaults.port),
  user: process.env.DB_USER ?? defaults.user,
  password: process.env.DB_PASSWORD ?? defaults.password,
  database: process.env.DB_NAME ?? defaults.database,
};
