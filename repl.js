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

  function parseObjectLiteral(str) {
    try {
      // Wrap keys in double quotes if not already
      const json = str
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')  // quote keys
        .replace(/'/g, '"'); // convert single quotes to double quotes
  
      return JSON.parse(json);
    } catch (err) {
      console.warn("⚠️ parseObjectLiteral failed:", err.message);
      return null;
    }
  }
  
  const formatDoc = (doc) => {
    if (doc instanceof ObjectId) {
      return `ObjectId("${doc.toHexString()}")`;
    }
  
    if (Array.isArray(doc)) {
      return doc.map(formatDoc);
    }
  
    if (doc && typeof doc === "object") {
      const out = {};
      for (const [k, v] of Object.entries(doc)) {
        out[k] = formatDoc(v);
      }
      return out;
    }
  
    return doc;
  };  

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
      useColors: true,
      useGlobal: true,
      ignoreUndefined: true,
      eval: async (cmd, context, filename, callback) => {
        try {
          const script = new vm.Script(cmd, { filename });
          const result = await script.runInContext(vm.createContext(context));
          if (Array.isArray(result)) {
            const formatted = result.map(formatDoc);
            if (prettyOutput) {
              console.log(util.inspect(formatted, { depth: null, colors: true, compact: false }));
            } else {
              console.dir(formatted, { depth: null });
            }
          } else {
            console.dir(result, { depth: null });
          }          
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

    function wrapCollectionWithShellFind(collection) {
      const originalFind = collection.find.bind(collection);
      collection.find = (query = {}, projection = {}) => {
        if (projection && !projection.projection) {
          return originalFind(query, { projection });
        }
        return originalFind(query, projection); // already valid
      };
      return collection;
    }

    async function setupCollectionAliases(context, db) {
      const collections = await db.listCollections().toArray();

      for (const { name } of collections) {
        try {
          const alias = name.replace(/[-\s]/g, "_");
          context[alias] = wrapCollectionWithShellFind(db.collection(name));
          // console.log(`📌 Alias added: ${alias} → db.collection("${name}")`);
        } catch (err) {
          console.warn(`⚠️ Could not create alias for ${name}: ${err.message}`);
        }
      }
    }

    // Custom commands
    r.defineCommand("use", {
      help: "Switch to another DB",
      async action(dbname) {
        if (!dbname) {
          console.log("⚠️  Please provide a database name");
          this.displayPrompt();
          return;
        }
    
        const trimmed = dbname.trim();
        const db = client.db(trimmed);
        r.context.db = db;
        r.context.currentDbName = trimmed;
    
        this.setPrompt(`${trimmed} > `);
        console.log(`✅ Switched to DB: ${trimmed}`);
        await setupCollectionAliases(r.context, db);
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
        const collections = await r.context.db.listCollections().toArray();
        console.log(`📁 Collections in "${r.context.db.databaseName}":`);
        collections.forEach((col) => console.log(` - ${col.name}`));
        this.displayPrompt();
      },
    });

    r.defineCommand("export", {
      help: "Export query results. Usage: .export <collection> [filterObject] [projectionObject] [filename]",
      async action(input) {
        // Match brace-delimited arguments like {foo: "bar"} even if spaced
        const regex = /{[^{}]*}|"[^"]*"|\S+/g;
        const rawArgs = input.match(regex) || [];
    
        const [collName, rawFilter, rawProjection, filename] = rawArgs.map(arg =>
          arg.trim().replace(/^['"]|['"]$/g, "")
        );
    
        if (!collName) {
          const result = this.context.$
          if (!result) {
            console.log("⚠️ Usage: .export <collection> [filterObject] [projectionObject] [filename]");
            return this.displayPrompt();
          }
          const csvData = jsonToCsv(result); // Make sure you’ve defined this function
          const fullPath = path.resolve(process.cwd(), 'export.csv');
          await fs.promises.writeFile(fullPath, csvData);
          console.log(`✅ Exported ${result.length} docs to CSV: ${fullPath}`);
          return this.displayPrompt();
        }
    
        let filter = {};
        let projection = {};
        let file = filename;

        if (!file) {
          if (rawFilter && (rawFilter.endsWith(".csv") || rawFilter.endsWith(".json"))) {
            file = rawFilter;
          } else if (rawProjection && (rawProjection.endsWith(".csv") || rawProjection.endsWith(".json"))) {
            file = rawProjection;
          } else {
            file = `${collName}.json`;
          }
        }
    
        if (rawFilter && rawFilter.startsWith("{")) {
          const parsed = parseObjectLiteral(rawFilter);
          if (parsed) filter = parsed;
          else console.log("⚠️ Invalid filter - exporting all");
        }
    
        if (rawProjection && rawProjection.startsWith("{")) {
          const parsed = parseObjectLiteral(rawProjection);
          if (parsed) projection = parsed;
          else console.log("⚠️ Invalid projection - exporting full documents");
        }
    
        try {
          const cursor = r.context.db.collection(collName).find(filter, { projection });
          const docs = await cursor.toArray();
          const fullPath = path.resolve(process.cwd(), file);
    
          if (file.endsWith(".csv")) {
            const csvData = jsonToCsv(docs); // Make sure you’ve defined this function
            await fs.promises.writeFile(fullPath, csvData);
            console.log(`✅ Exported ${docs.length} docs to CSV: ${fullPath}`);
          } else {
            await fs.promises.writeFile(fullPath, JSON.stringify(docs, null, 2));
            console.log(`✅ Exported ${docs.length} docs to JSON: ${fullPath}`);
          }
        } catch (err) {
          console.error(`❌ Export failed: ${err.message}`);
        }
    
        this.displayPrompt();
      },
    });
    
    r.defineCommand('count', {
      help: 'Count documents in a collection with an optional query.\nUsage: .count <collection> [<queryJSON>]',
      async action(input) {
        const [collName, ...queryParts] = input.trim().split(/\s+/);
        if (!collName) {
          console.log('⚠️  Usage: .count <collection> [<queryJSON>]');
          return this.displayPrompt();
        }
    
        let query = {};
        if (queryParts.length > 0) {
          try {
            // query = eval('(' + queryParts.join(' ') + ')'); // safe-ish for REPL use
            const joined = queryParts.join(' ');
            const transformed = joined.replace(/ObjectId\((["'`])(.+?)\1\)/g, (_, __, id) => {
              return `new ObjectId("${id}")`;
            });
            query = eval(`(${transformed})`);
          } catch (e) {
            console.error('❌ Invalid query JSON:', e.message);
            return this.displayPrompt();
          }
        }
    
        try {
          const count = await r.context.db.collection(collName).countDocuments(query);
          console.log(`📊 Count for "${collName}": ${count}`);
        } catch (err) {
          console.error('❌ Error:', err.message);
        }
    
        this.displayPrompt();
      }
    });

    r.defineCommand('distinct', {
      help: 'Get distinct values for a field in a collection.\nUsage: .distinct <collection> <field> [<query>]',
      async action(input) {
        const args = input.trim().match(/"[^"]+"|'[^']+'|\S+/g) || [];
    
        const [collName, field, ...queryParts] = args.map(arg =>
          arg.replace(/^["']|["']$/g, '')
        );
    
        if (!collName || !field) {
          console.log('⚠️ Usage: .distinct <collection> <field> [<query>]');
          return this.displayPrompt();
        }
    
        let query = {};
        if (queryParts.length) {
          try {
            // query = eval('(' + queryParts.join(' ') + ')'); // intentionally REPL-friendly
            const joined = queryParts.join(' ');
            const transformed = joined.replace(/ObjectId\((["'`])(.+?)\1\)/g, (_, __, id) => {
              return `new ObjectId("${id}")`;
            });
            query = eval(`(${transformed})`);
          } catch (e) {
            console.error('❌ Invalid query object:', e.message);
            return this.displayPrompt();
          }
        }
    
        try {
          const values = await r.context.db.collection(collName).distinct(field, query);
          console.log(`🔎 Distinct values for "${field}" (${values.length}):`);
          console.log(values);
        } catch (err) {
          console.error('❌ Error:', err.message);
        }
    
        this.displayPrompt();
      }
    });

    r.defineCommand('aggregate', {
      help: 'Run an aggregation pipeline.\nUsage: .aggregate <collection> <pipelineJSON>',
      async action(input) {
        const args = input.trim().match(/"[^"]+"|'[^']+'|\S+/g) || [];
    
        const [collName, ...pipelineParts] = args.map(arg =>
          arg.replace(/^['"]|['"]$/g, '')
        );
    
        if (!collName || pipelineParts.length === 0) {
          console.log('⚠️ Usage: .aggregate <collection> <pipelineJSON>');
          return this.displayPrompt();
        }
    
        let pipeline = [];
        try {
          // pipeline = eval('(' + pipelineParts.join(' ') + ')'); // Safe for REPL-style input
          const joined = pipelineParts.join(' ');
            const transformed = joined.replace(/ObjectId\((["'`])(.+?)\1\)/g, (_, __, id) => {
              return `new ObjectId("${id}")`;
            });
            pipeline = eval(`(${transformed})`);
          if (!Array.isArray(pipeline)) throw new Error("Pipeline must be an array");
        } catch (e) {
          console.error('❌ Invalid pipeline JSON:', e.message);
          return this.displayPrompt();
        }
    
        try {
          const cursor = r.context.db.collection(collName).aggregate(pipeline);
          const result = await cursor.toArray();
    
          if (Array.isArray(result)) {
            console.table(result.slice(0, 10)); // Preview first 10
          } else {
            console.dir(result, { depth: null });
          }
    
          // Optionally store in context for further use
          this.context.$ = result;
        } catch (err) {
          console.error('❌ Aggregation failed:', err.message);
        }
    
        this.displayPrompt();
      }
    });
    
    r.defineCommand("indexes", {
      help: "List indexes of a collection. Usage: .indexes <collectionName>",
      async action(collName) {
        if (!collName) {
          console.log("❗ Provide a collection name");
          this.displayPrompt();
          return;
        }
    
        try {
          const indexes = await r.context.db.collection(collName).indexes();
          console.table(indexes);
        } catch (err) {
          console.error("⚠️", err.message);
        }
    
        this.displayPrompt();
      },
    });
    
    r.defineCommand("findOne", {
      help: "Find one doc. Usage: .findOne <collectionName> <optionalJSONFilter>",
      async action(line) {
        const [collName, ...filterParts] = line.trim().split(" ");
        let filter = {};
    
        try {
          if (filterParts.length > 0) {
            const raw = filterParts.join(" ");
            const transformed = raw.replace(/ObjectId\((["'`])(.+?)\1\)/g, (_, __, id) => {
              return `new ObjectId("${id}")`;
            });
            filter = eval(`(${transformed})`); // Only one eval needed
          }
    
          const doc = await r.context.db.collection(collName).findOne(filter);
          console.log(util.inspect(doc, { colors: true, depth: null }));
        } catch (err) {
          console.error("⚠️", err.message);
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

    r.defineCommand("table", {
      help: "Show table output",
      action() {
        // 🪄 Nicely format the output
        if (this.context.$ && Array.isArray(this.context.$)) {
          console.table(this.context.$);
        } else {
          let result = this.context.$;
          if (!result) {
            console.error("⚠️ Usage: .table No Results");
            return this.displayPrompt();
          }
          if (Array.isArray(result)) {
            const formatted = result.map(formatDoc);
            if (prettyOutput) {
              console.log(util.inspect(formatted, { depth: null, colors: true, compact: false }));
            } else {
              console.dir(formatted, { depth: null });
            }
          } else {
            console.dir(result, { depth: null });
          }
        }
        this.displayPrompt();
      },
    });

    r.defineCommand("clear", {
      help: "Clear the console screen",
      action() {
        process.stdout.write('\x1Bc');
        this.displayPrompt();
      },
    });

    r.defineCommand("help", {
      help: "Show available REPL commands",
      action() {
        console.log(`
      🛠  Available commands:
      .use <dbname>                                        - Switch database
      .databases                                           - List all DBs
      .collections                                         - List collections in current DB
      .export <collection> [query] [projection] [filename] - Export query results
      .count <collection> [query]                          - Get document count
      .distinct <collection> <field> [query]               - Get distinct values for a field
      .aggregate <collection> <pipelineJSON>               - Run an aggregation pipeline
      .indexes <collectionName>                            - List indexes of a collection
      .findOne <collectionName> <optionalJSONFilter>       - Find one doc
      .exit / .quit                                        - Exit the shell
      .pretty                                              - Toggle pretty JSON output
      .clear                                               - Clear the console screen
      .table                                               - Show table output
      
      📌 Aliases like: journey.find() or logs.findOne() also work
      📌 Export ex: .export journey {"status":"active"} {} active_data.csv
      📌 Export ex: .export journey {"status":"active"} {"status":1} active_data.csv
      📌 Count ex: .count journey {"status":"active"}
      📌 Distinct ex: .distinct journey "status"
      📌 Distinct ex: .distinct journey "status" {"status":"active"}
      📌 Aggregate ex: .aggregate journey [{$match: {"status": "active"}}, {$group: {_id: "$status", count: {$sum: 1}}}]
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
