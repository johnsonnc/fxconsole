var util = require("util"),
  url = require("url"),
  path = require("path"),
  repl = require("repl"),
  colors = require("colors"),
  FirefoxClient = require("firefox-client");
var exec = require('child_process').exec;

const PROP_SHOW_COUNT = 5;

module.exports = FirefoxREPL;

function FirefoxREPL() {}

FirefoxREPL.prototype = {

  start: function (options) {
    this.connect(options, function (err, tab) {
      if (err) throw err;

      console.log(tab.url.yellow);

      this.setTab(tab);

      this.repl = repl.start({
        prompt: this.getPrompt(),
        eval: this.eval.bind(this),
        input: process.stdin,
        output: process.stdout,
        writer: this.writer.bind(this)
      });

      this.defineCommands();
      this.startConsoleListener();

    }.bind(this));
  },

  connect: function (options, cb) {
    var client = new FirefoxClient();
    client.connect(options.port, options.host, function () {
      client.selectedTab(cb);
    });
    client.on("error", function (error) {
      if (error.code == "ECONNREFUSED") {
        throw new Error(error.code + ": Firefox isn't listening for connections");
      }
      throw error;
    });
    client.on("end", this.quit);

    this.client = client;
  },

  writer: function (output) {
    if (!output || output.type != "object") {
      // let inspect do its thing if it's a literal
      return util.inspect(output, {
        colors: true
      });
    }
    // do our own object summary
    var str = "";
    str += output.class.yellow + " { ";

    var props = {};

    // show first N properties of an object, starting with getters
    var getters = output.safeGetterValues;
    var names = Object.keys(getters).slice(0, PROP_SHOW_COUNT);
    names.map(function (name) {
      props[name] = getters[name];
    });

    // then the own properties
    var ownProps = output.ownProps;
    var remaining = PROP_SHOW_COUNT - names.length;
    if (remaining) {
      names = Object.keys(ownProps).slice(0, remaining);
      names.map(function (name) {
        props[name] = ownProps[name];
      });
    }

    // write out a few properties and their values
    var strs = [];
    for (var name in props) {
      var value = props[name].value;
      value = this.transformResult(value);

      if (value && value.type == "object") {
        value = ("[object " + value.class + "]").cyan;
      } else {
        value = util.inspect(props[name].value, {
          colors: true
        });
      }
      strs.push(name.magenta + ": " + value);
    }
    str += strs.join(", ");

    // write the number of remaining properties
    var total = Object.keys(getters).length + Object.keys(ownProps).length;
    var more = total - PROP_SHOW_COUNT;
    if (more > 0) {
      str += ", ..." + (more + " more").grey;
    }
    str += " } ";

    return str;
  },

  write: function (str, cb) {
    this.repl.outputStream.write(str, cb);
  },

  setTab: function (tab) {
    this.tab = tab;

    if (this.repl) {
      // repl.prompt not documented in REPL module
      this.repl.prompt = this.getPrompt();
    }
    this.startConsoleListener();
  },

  getPrompt: function () {
    var parts = url.parse(this.tab.url);

    var name = parts.hostname;
    if (!name) {
      name = path.basename(parts.path);
    }
    return name + "> ";
  },

  // compliant with node REPL module eval function reqs
  eval: function (cmd, context, filename, cb) {
    this.evalInTab(cmd, cb);
  },

  startConsoleListener: function () {

    this.tab.Console.on("console-api-call", function (event) {
      var mesg = "";
      var lineNumber = event.lineNumber;

      var loc = url.parse(event.filename, true).pathname;

      if (this.storage.length > 2000) {
        this.storage.length = 0;
        this.consoleErrorCount = 0;
      }
      this.storage.push({
        msg: mesg,
        lineNum: lineNumber,
        columnNum: 0,
        path: loc
      });


      mesg = "Error # " + this.consoleErrorCount + " : " + mesg;
      this.consoleErrorCount = this.consoleErrorCount + 1;
      for (var i = 0; i < event.arguments.length; i = i + 1) {

        if (event.level === "error") {
          mesg += (event.arguments[i]).red; // no idea whats going on here yet.
        } else if (event.level === "log") {
          mesg += (event.arguments[i]).white;
        } else if (event.level === "warning") {
          mesg += (event.arguments[i]).yellow;
        } else if (event.level === "info") {
          if (typeof (event.arguments[i].client) !== "object") {
            mesg += (event.arguments[i]).green;
          } else {
            mesg += "Unknown Error occured at " + loc + "@" + event.lineNumber + "(thats all we know)";
            mesg = mesg.red;
          }
        }
      }

      if (mesg !== undefined && mesg !== null) {
        this.write(mesg + "\n ");
      } else {
        console.dir(event);
      }

      this.repl.displayPrompt();

    }.bind(this));

    this.tab.Console.on("page - error ", function (event) {

      var msg = event.errorMessage;
      var lineNumber = event.lineNumber;
      var columnNumber = event.columnNumber;
      var loc = url.parse(event.sourceName, true).pathname;

      if (this.storage.length > 2000) {
        this.storage.length = 0;
        this.consoleErrorCount = 0;
      }
      this.storage.push({
        msg: msg,
        lineNum: lineNumber,
        columnNum: columnNumber,
        path: loc
      });


      msg = "Error # " + this.consoleErrorCount + ": " + msg;
      this.consoleErrorCount = this.consoleErrorCount + 1;
      if (event.warning === true) {

        msg = msg.yellow;
      } else if (event.error === true) {

        msg = msg.red;
      } else if (event.exception === true) {

        msg = msg.cyan;
      } else {
        msg = msg;
      }
      //  }
      if (msg !== undefined && msg !== null) {
        this.write(msg + "\n ");
      } else {
        console.dir(event);
      }

      this.repl.displayPrompt();
    }.bind(this));

    this.tab.Console.startListening();
  },
  storage: [],
  consoleErrorCount: 0,
  evalInTab: function (input, cb) {
    this.tab.Console.evaluateJS(input, function (err, resp) {
      if (err) throw err;

      if (resp.exception) {
        cb(resp.exceptionMessage);
        return;
      }

      var result = resp.result;

      if (result.type == "object ") {
        result.ownPropertiesAndPrototype(function (err, resp) {
          if (err) return cb(err);

          result.safeGetterValues = resp.safeGetterValues;
          result.ownProps = resp.ownProperties;

          cb(null, result);
        });
      } else {
        cb(null, this.transformResult(resp.result));
      }
    }.bind(this));
  },

  transformResult: function (result) {
    switch (result.type) {
    case "undefined ":
      return undefined;
    case "null ":
      return null;
    }
    return result;
  },

  defineCommands: function () {
    this.repl.defineCommand("tabs", {
      help: "list currently open tabs ",
      action: this.listTabs.bind(this)
    });

    this.repl.defineCommand("quit", {
      help: "quit fxconsole ",
      action: this.quit
    });

    this.repl.defineCommand("switch", {
      help: "switch to evaluating in another tab by index",
      action: this.switchTab.bind(this)
    });

    this.repl.defineCommand("go", {
      help: "launch ide with said error number ",
      action: this.launch.bind(this)
    });

  },
  launch: function (errorNo) {
    var success = false;
    if (parseInt(errorNo) === "NaN") {
      throw new Error("Error number was not a number.");
    }

    var ac = this.storage[errorNo];
    for (var i in this.paths) {
      var path = ac.path;
      var sp = path.split(i);

      if (sp.length > 1) {
        var exPath = this.paths[i] + sp[1];
        var editor = this.editor;

        var cmd = editor.command + " " + exPath + editor.line + ac.lineNum + editor.column + ac.columnNum;
        cmd = cmd;
        console.log("launching: " + cmd);

        exec(cmd);
        success = true;
        this.repl.displayPrompt();
      }
    }
    if (success !== true) {
      console.log("Can 't Launch : No Path Match");
    }

  },
  paths: {
    "/emp-map/": "/workspace/projects/extensible-mapping-platform/trunk/emp-map/src/main/webapp/",
    "/cpce-map-api/": "/workspace/projects/extensible-mapping-platform/trunk/emp-map-api/src/main/webapp/"
  },
  editor: {
    command: "/home/johnsonnc/Downloads/Sublime\\ Text\\ 2/sublime_text",
    line: ":",
    column: ":"
  },
  switchTab: function (index) {
    this.client.listTabs(function (err, tabs) {
      if (err) throw err;
      var tab = tabs[index];

      if (!tab) {
        this.write("no tab at index " + index + "\n");
      } else {
        this.setTab(tab);
        this.write((this.tab.url + "\n").yellow);
      }

      this.repl.displayPrompt();
    }.bind(this));
  },

  listTabs: function () {
    this.client.listTabs(function (err, tabs) {
      if (err) throw err;

      var strs = "";
      for (var i in tabs) {
        strs += "[" + i + "] " + tabs[i].url + "\n";
      }

      this.write(strs);

      // displayPrompt() not listed in REPL module docs <.<
      this.repl.displayPrompt();
    }.bind(this));
  },

  quit: function () {
    process.exit(0);
  }
};