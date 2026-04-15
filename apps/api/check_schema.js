const { Pool } = require("pg");

const pool = new Pool({
  host: "20.219.26.128",
  port: 5432,
  user: "convixx_user",
  password: "P@ssw0rd#2026",
  database: "convixx_kb"
});

pool.query(`
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'agents';
`)
  .then(res => {
    console.log(res.rows);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
