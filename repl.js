#!/usr/bin/env node

const { MongoClient, ObjectId, Binary, Timestamp } = require("mongodb");
const readline = require("readline");
const url = require("url");
const querystring = require("querystring");
const repl = require("repl");
const vm = require("vm");
const fs = require("fs");

// CLI input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Enter MongoDB connection URI: ", async (uri) => {
  const parsedUrl = url.parse(uri);
  const params = querystring.parse(parsedUrl.query);

  const options = {};

  // TLS support (PEM file paths in URI)
  if (params.tlsCertificateKeyFile && params.tlsCAFile) {
    options.tls = true;
    options.tlsCertificateKeyFile = decodeURIComponent(
      params.tlsCertificateKeyFile
    );
    options.tlsCAFile = decodeURIComponent(params.tlsCAFile);
    options.tlsAllowInvalidCertificates = true;

    // console.log("🔑 TLS Certificate Key File:", options.tlsCertificateKeyFile);
    // console.log("🔑 TLS CA File:", options.tlsCAFile);
  }

  rl.close();

  function jsonToCsv(data) {
    if (!data.length) return "";

    const headers = Object.keys(data[0]);
    const csv = [headers.join(",")];

    for (const row of data) {
      const values = headers.map((key) => {
        const val = row[key];
        if (typeof val === "object")
          return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        return `"${String(val).replace(/"/g, '""')}"`;
      });
      csv.push(values.join(","));
    }

    return csv.join("\n");
  }

  let client;
  try {
    client = new MongoClient(uri, options);
    await client.connect();
    console.log("✅ Connected to MongoDB");

    let currentDb = client.db(); // Default DB

    let prettyOutput = false;
    // Start REPL shell
    const r = repl.start({
      prompt: `${currentDb.databaseName} > `,
      useGlobal: true,
      ignoreUndefined: true,
      eval: async (cmd, context, filename, callback) => {
        try {
          const script = new vm.Script(cmd, { filename });
          const result = await script.runInContext(vm.createContext(context));
          // 🪄 Nicely format the output
          //   if (Array.isArray(result)) {
          //     console.table(result.slice(0, 10));
          //   } else {
          if (prettyOutput && typeof result === "object") {
            console.log(
              util.inspect(result, {
                depth: null,
                colors: true,
                compact: false,
              })
            );
          } else {
            console.dir(result, { depth: null });
          }
          //   }

          // 📦 Store in REPL context if needed (optional)
          context.$ = result; // Like native Mongo shell

          callback(null, undefined);
        } catch (err) {
          callback(err);
        }
      },
    });

    // Make DB accessible
    r.context.client = client;
    r.context.db = currentDb;
    // Inject common Mongo shell helpers
    r.context.ObjectId = (id) => new ObjectId(id);
    r.context.ISODate = (str) => new Date(str);
    r.context.UUID = (str) => Binary.from(str, 4);
    r.context.BinData = (subtype, str) => Binary.from(str, subtype);
    r.context.NumberLong = (val) => BigInt(val);
    r.context.NumberInt = (val) => parseInt(val);
    r.context.Timestamp = Timestamp;

    async function setupCollectionAliases(context, db) {
      const collections = await db.listCollections().toArray();

      for (const { name } of collections) {
        try {
          const alias = name.replace(/[-\s]/g, "_");
          context[alias] = db.collection(name);
          console.log(`📌 Alias added: ${alias} → db.collection("${name}")`);
        } catch (err) {
          console.warn(`⚠️ Could not create alias for ${name}: ${err.message}`);
        }
      }
    }

    // Custom commands
    r.defineCommand("use", {
      help: "Switch database. Usage: .use <dbname>",
      async action(dbname) {
        if (!dbname) {
          console.log("⚠️  Please provide a database name");
          this.displayPrompt();
          return;
        }
        currentDb = client.db(dbname.trim());
        r.context.db = currentDb;
        this.setPrompt(`${dbname.trim()} > `);
        console.log(`✅ Switched to DB: ${dbname.trim()}`);
        await setupCollectionAliases(r.context, currentDb);
        this.displayPrompt();
      },
    });

    r.defineCommand("databases", {
      help: "List all databases",
      async action() {
        const dbs = await client.db().admin().listDatabases();
        console.log("📚 Databases:");
        dbs.databases.forEach((db) => console.log(` - ${db.name}`));
        this.displayPrompt();
      },
    });

    r.defineCommand("collections", {
      help: "List collections in current DB",
      async action() {
        const collections = await currentDb.listCollections().toArray();
        console.log(`📁 Collections in "${currentDb.databaseName}":`);
        collections.forEach((col) => console.log(` - ${col.name}`));
        this.displayPrompt();
      },
    });

    r.defineCommand("export", {
      help: "Export query results. Usage: .export <collection> [filterJSON] [projectionJSON] [filename]",
      async action(input) {
        const args = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        if (args.length < 1) {
          console.log(
            "⚠️ Usage: .export <collection> [filterJSON] [projectionJSON] [filename]"
          );
          return this.displayPrompt();
        }

        const collName = args[0];
        let filter = {};
        let projection = {};
        let file = `${collName}.json`;

        if (args.length >= 2) {
          try {
            filter = JSON.parse(args[1].replace(/^['"]|['"]$/g, ""));
          } catch {
            console.log("⚠️ Invalid filter JSON - exporting all");
          }
        }

        if (args.length >= 3) {
          try {
            projection = JSON.parse(args[2].replace(/^['"]|['"]$/g, ""));
          } catch {
            console.log(
              "⚠️ Invalid projection JSON - exporting full documents"
            );
          }
        }

        if (args.length >= 4) {
          file = args[3];
        }

        try {
          const cursor = currentDb
            .collection(collName)
            .find(filter, { projection });
          const docs = await cursor.toArray();

          const fullPath = require("path").resolve(process.cwd(), file);

          if (file.endsWith(".csv")) {
            const csvData = jsonToCsv(docs);
            await fs.promises.writeFile(fullPath, csvData);
            console.log(`✅ Exported ${docs.length} docs to CSV: ${fullPath}`);
          } else {
            await fs.promises.writeFile(
              fullPath,
              JSON.stringify(docs, null, 2)
            );
            console.log(`✅ Exported ${docs.length} docs to JSON: ${fullPath}`);
          }
        } catch (err) {
          console.error(`❌ Export failed: ${err.message}`);
        }

        this.displayPrompt();
      },
    });

    r.defineCommand("count", {
      help: "Get document count. Usage: .count <collection>",
      async action(collName) {
        if (!collName) return console.log("⚠️ Usage: .count <collection>");
        const count = await currentDb.collection(collName).countDocuments();
        console.log(`📊 ${collName} count: ${count}`);
        this.displayPrompt();
      },
    });

    r.defineCommand("stats", {
      help: "Get stats for a collection. Usage: .stats <collection>",
      async action(collName) {
        if (!collName) return console.log("⚠️ Usage: .stats <collection>");
        const stats = await currentDb.command({ collStats: collName });
        if (prettyOutput && typeof result === "object") {
          console.log(
            util.inspect(result, { depth: null, colors: true, compact: false })
          );
        } else {
          console.dir(result, { depth: null });
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("top", {
      help: "Find top 5 docs from a collection. Usage: .top <collection>",
      async action(collName) {
        if (!collName) return console.log("⚠️ Usage: .top <collection>");
        const docs = await currentDb
          .collection(collName)
          .find()
          .limit(5)
          .toArray();
        if (prettyOutput && typeof result === "object") {
          console.log(
            util.inspect(result, { depth: null, colors: true, compact: false })
          );
        } else {
          console.dir(result, { depth: null });
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("pretty", {
      help: "Toggle pretty JSON output",
      action() {
        prettyOutput = !prettyOutput;
        console.log(`📦 Pretty output: ${prettyOutput ? "ON" : "OFF"}`);
        this.displayPrompt();
      },
    });

    r.defineCommand("clear", {
      help: "Clear the console screen",
      action() {
        console.clear();
        this.displayPrompt();
      },
    });

    r.defineCommand("helpme", {
      help: "Show available REPL commands",
      action() {
        console.log(`
      🛠  Available commands:
      .use <dbname>                                        - Switch database
      .databases                                           - List all DBs
      .collections                                         - List collections in current DB
      .export <collection> [query] [projection] [filename] - Export query results
      .count <collection>                                  - Get document count
      .stats <collection>                                  - Get stats for a collection
      .top <collection>                                    - Find top 5 docs from a collection
      .exit / .quit                                        - Exit the shell
      .pretty                                              - Toggle pretty JSON output
      .clear                                               - Clear the console screen
      
      📌 Aliases like: journey.find() or logs.findOne() also work
      📌 Export ex: .export journey '{"status":"active"}' '{"status":1}' active_data.csv
          `);
        this.displayPrompt();
      },
    });

    r.defineCommand("exit", {
      help: "Exit the REPL",
      async action() {
        console.log("👋 Bye!");
        await client.close();
        process.exit(0);
      },
    });
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
    if (client) await client.close();
    process.exit(1);
  }
});
