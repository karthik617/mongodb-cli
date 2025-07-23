#!/usr/bin/env node

const { Client } = require("pg");
const repl = require("repl");
const fs = require("fs");
const path = require("path");
const prompt = require("prompt-sync")({ sigint: true });

process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Error:", err.message);
  process.exit(1);
});

const MAX_PREVIEW_LENGTH = 10;

// Function to safely truncate strings and replace nested objects with placeholder
function prettyFormatRows(rows) {
  return rows.map((row) => {
    const newRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        newRow[key] = value;
      } else if (typeof value === "string") {
        newRow[key] =
          value.length > MAX_PREVIEW_LENGTH
            ? value.slice(0, MAX_PREVIEW_LENGTH) + "..."
            : value;
      } else if (typeof value === "object") {
        newRow[key] = "[Object]";
      } else {
        newRow[key] = value;
      }
    }
    return newRow;
  });
}

function encodePostgresURI(uri) {
  try {
    const parsed = new URL(uri);
    if (
      parsed.password &&
      decodeURIComponent(parsed.password) === parsed.password
    ) {
      parsed.password = encodeURIComponent(parsed.password);
      return parsed.toString();
    }
  } catch (e) {
    console.warn("⚠️ URI parsing failed. Please check formatting.");
  }
  return uri;
}

// Step 1: Choose URI or individual fields
console.log("🔌 PostgreSQL Connection Setup");
console.log("1. Enter full connection URI");
console.log("2. Enter individual values");
const choice = prompt("Choose [1/2]: ").trim();

let uri = "";

if (choice === "1") {
  uri = prompt("Enter PostgreSQL connection URI: ").trim();
} else {
  const user = prompt("User: ");
  const pass = encodeURIComponent(prompt("Password: ", { echo: "*" }));
  const host = prompt("Host: ");
  const port = prompt("Port (default 5432): ") || "5432";
  const db = prompt("Database: ");
  uri = `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

const safeUri = encodePostgresURI(uri);
let client = new Client({ connectionString: safeUri });

(async () => {
  try {
    await client.connect();
    console.log("✅ Connected to PostgreSQL");

    const dbName = uri.split("/").pop().split("?")[0];

    const r = repl.start({
      prompt: `${dbName} > `,
      useColors: true,
      ignoreUndefined: true,
      eval: async (cmd, context, filename, callback) => {
        try {
          console.time("⏱️ Query Time");
          const result = await client.query(cmd);
          console.timeEnd("⏱️ Query Time");
          context.$ = result.rows;
          if (result.rows.length === 0) {
            console.log("No results");
          } else {
            // const previewRows = prettyFormatRows(result.rows);
            // console.table(previewRows);
            console.table(result.rows);
          }
          callback(null);
        } catch (err) {
          callback(err);
        }
      },
    });

    r.context.client = client;

    // --- REPL Commands ---

    r.defineCommand("tables", {
      help: "List all tables",
      async action() {
        const res = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public';
        `);
        console.log("📁 Tables:");
        res.rows.forEach((row) => console.log(` - ${row.table_name}`));
        this.displayPrompt();
      },
    });

    r.defineCommand("use", {
      help: "Switch to another PostgreSQL database",
      async action(databaseName) {
        try {
          await client.end(); // disconnect from current DB

          let newUrl = new URL(uri);
          newUrl.pathname = `/${databaseName}`;
          client = new Client({ connectionString: newUrl.toString() });

          await client.connect();
          currentDbName = databaseName;
          this.setPrompt(`${currentDbName} > `);
          console.log(`🔁 Switched to database: ${databaseName}`);
        } catch (err) {
          console.error(`❌ Failed to switch:`, err.message);
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("describe", {
      help: "Describe a table's structure",
      async action(tableName) {
        try {
          const result = await client.query(
            `
              SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_name = $1
              ORDER BY ordinal_position;
            `,
            [tableName]
          );

          if (result.rows.length === 0) {
            console.log(`⚠️ Table '${tableName}' not found.`);
          } else {
            console.table(result.rows);
          }
        } catch (err) {
          console.error(`❌ Error describing table:`, err.message);
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("query", {
      help: "Execute SQL query: .query SELECT * FROM my_table",
      async action(sql) {
        try {
          console.time("⏱️ Query Time");
          const result = await client.query(sql);
          console.timeEnd("⏱️ Query Time");

          if (result.rows.length === 0) {
            console.log("No results");
          } else {
            // const previewRows = prettyFormatRows(result.rows.slice(0, 10));
            // console.table(previewRows);
            console.table(result.rows);
          }
        } catch (err) {
          console.error(`❌ Query error:`, err.message);
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("queryp", {
      help: "Execute SQL query: .queryp Select * from my_table where id = $1",
      async action(query) {
        try {
          const paramMatches = [...query.matchAll(/\$([0-9]+)/g)].map((m) =>
            parseInt(m[1])
          );
          const paramCount = Math.max(0, ...paramMatches);
          let params = [];
          for (let i = 1; i <= paramCount; i++) {
            let val = prompt(`Enter value for $${i}: `).trim();
            params.push(val);
          }
          console.time("⏱️ Query Time");
          const result = await client.query(query, params);
          console.timeEnd("⏱️ Query Time");

          if (result.rows.length === 0) {
            console.log("No results");
          } else {
            // const previewRows = prettyFormatRows(result.rows.slice(0, 10));
            // console.table(previewRows);
            console.table(result.rows);
          }
        } catch (err) {
          console.error(`❌ Query error:`, err.message);
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("count", {
      help: "Count rows in a table. Usage: .count <tableName>",
      async action(input) {
        try {
          const table = input.trim();
          console.time("⏱️ Query Time");
          const result = await client.query(`SELECT COUNT(*) FROM ${table}`);
          console.timeEnd("⏱️ Query Time");
          console.log(`📊 Count: ${result.rows[0].count}`);
        } catch (e) {
          console.error("❌ Error:", e.message);
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("export", {
      help: "Export last result to CSV. Usage: .export <filename.csv>",
      async action(input) {
        if (!r.context.$ || !Array.isArray(r.context.$)) {
          console.log("⚠️  No result to export");
          return this.displayPrompt();
        }

        const headers = Object.keys(r.context.$[0]);
        const csv = [headers.join(",")];
        for (const row of r.context.$) {
          const values = headers.map(
            (h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`
          );
          csv.push(values.join(","));
        }

        const filename = input.trim() || "export.csv";
        await fs.promises.writeFile(
          path.resolve(process.cwd(), filename),
          csv.join("\n")
        );
        console.log(`✅ Exported to ${filename}`);
        this.displayPrompt();
      },
    });

    r.defineCommand("exit", {
      help: "Exit the REPL",
      async action() {
        await client.end();
        console.log("👋 Bye!");
        process.exit(0);
      },
    });

    r.defineCommand("clear", {
      help: "Clear the console screen",
      action() {
        process.stdout.write("\x1Bc");
        this.displayPrompt();
      },
    });

    r.defineCommand("help", {
      help: "Show available commands",
      action() {
        console.log(`
      🛠️ Available REPL Commands:
      .tables             - List all tables
      .count <table>      - Count rows in a table
      .export <file.csv>  - Export last result to CSV
      .use <db>           - Switch to another PostgreSQL database
      .describe <table>   - Describe a table's structure
      .query <sql>        - Execute SQL query
      .queryp <sql>       - Execute SQL query with parameters
      .exit               - Exit
      .clear              - Clear the console screen
      .help               - Show help
        `);
        this.displayPrompt();
      },
    });
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
    process.exit(1);
  }
})();
