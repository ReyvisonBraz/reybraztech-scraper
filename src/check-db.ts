import postgres from 'postgres';
import * as dotenv from 'dotenv';
dotenv.config();

const connectionString = process.env.DATABASE_URL;
const sql = postgres(connectionString!, {
  ssl: 'require',
});

async function main() {
  try {
    const clientsCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'clients'
    `;
    console.log("Columns in clients table:", clientsCols);
    
    // Check if there is another table for scraped clients?
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    console.log("Tables:", tables.map(t => t.table_name));
    
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

main();
