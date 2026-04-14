/**
 * პროდაქშენი (APP_ENV=prod ან NODE_ENV=production)
 *
 * 1) ჯერ გამოიყენება გარემო: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 * 2) თუ ჰოსტი env-ს არ აძლევს — შეავსე `defaults.password` (ან მთლიანი defaults) ამ ფაილში სერვერზე.
 *    არ ატვირთო რეპოში რეალური პაროლი თუ repo public არის.
 */
// ლაივი (demonext / MySQL პანელის მიხედვით). DB_* env უპირატესია თუ ჰოსტზე გაქვს.
const defaults = {
  host: "localhost",
  port: 3306,
  user: "lcrypto",
  password: "NiNuca199@",
  database: "finance",
};

export default {
  host: process.env.DB_HOST ?? defaults.host,
  port: Number(process.env.DB_PORT ?? defaults.port),
  user: process.env.DB_USER ?? defaults.user,
  password: process.env.DB_PASSWORD ?? defaults.password,
  database: process.env.DB_NAME ?? defaults.database,
};
