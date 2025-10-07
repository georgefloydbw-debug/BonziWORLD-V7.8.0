//Load dependencies
const fs = require("fs");
const http = require("http");
const express = require("express");
const socketio = require("socket.io");
const crypto = require("crypto");
const ipaddr = require('ipaddr.js');
const commands = require("./commands.js");

// Fix for Render: Use environment port
const PORT = process.env.PORT || 3000;

let uptime = 0;
setInterval(()=>{
    uptime++;
    Object.keys(rooms).forEach(room=>{
        rooms[room].reg++;
        Object.keys(rooms[room].users).forEach(user=>{
            rooms[room].users[user].public.joined++;
        })
    })
}, 60000)

let blacklist = ["kosmi.io","kosmi.to", ".onion", ".xn--onion", "msagent.chat"];
function checkBlacklist(param){
    bad = false;
    blacklist.forEach((badword)=>{
        if(param.toLowerCase().includes(badword.toLowerCase())) bad = true;
    })
    return bad;
}

function isIPInBlockedRanges(ip) {
    try {
        const parsedIP = ipaddr.parse(ip);
        return blockedIPRanges.some(range => {
            const subnet = ipaddr.parseCIDR(range);
            return parsedIP.match(subnet);
        });
    } catch (error) {
        console.error('IP parsing error:', error);
        return false;
    }
}

//Read settings (READER IN COMMANDS LIBRARY)
const config = commands.config;
const colors = commands.colors;
const markup = commands.markup;
const markUpName = commands.markUpName;

// Initialize files safely for Render
function initializeFile(path, defaultValue = "") {
    try {
        if (fs.existsSync(path)) {
            return fs.readFileSync(path).toString();
        } else {
            console.log(`Creating missing file: ${path}`);
            // Create directory if it doesn't exist
            const dir = path.split('/').slice(0, -1).join('/');
            if (dir && !fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(path, defaultValue);
            return defaultValue;
        }
    } catch (e) {
        console.log(`Error initializing ${path}:`, e.message);
        return defaultValue;
    }
}

// Initialize VPN cache
try {
    commands.vpncache = initializeFile("./config/vpncache.txt", "").split("\n").filter(e => e).map(e=>{return e.split("/")});
} catch (e) {
    console.log("Error loading vpncache, using empty array");
    commands.vpncache = [];
}

function isVPN(ip){
    let x = 0;
    commands.vpncache.forEach(e=>{
        if(e[0] == ip && e[1] == "true") x = 2;
        else if(e[0] == ip) x = 1;
    })
    return x;
}

//IP info
const ipinfo = {}

function bancheck(id) {
    // Early return for undefined, null, or empty ID
    if (!id || typeof id !== 'string') return -1;

    // Early return if no bans exist
    if (!commands.bans || commands.bans.length === 0) return -1;

    // Use Array.findIndex to check banned GUIDs
    return commands.bans.findIndex((bannedId) => bannedId === id);
}

// Initialize bans safely
try {
    commands.bans = initializeFile("./config/bans.txt", "").split("\n").filter(e => e).map(e=>{return e.split("/")[0]});
    commands.reasons = initializeFile("./config/bans.txt", "").split("\n").filter(e => e).map(e=>{return e.split("/")[1]});
} catch (e) {
    console.log("Error loading bans, using empty arrays");
    commands.bans = [];
    commands.reasons = [];
}

const blockedIPRanges = [
    "2600:1017:",  // Original range
];

//HTTP Server
const app = new express();

//Statistics
app.use("/stats", (req, res, next)=>{
    res.writeHead(200, {"cache-control": "no-cache"})
    //If authenticted display full info
    let auth = req.query.auth == undefined ? "" : crypto.createHash("sha256").update(req.query.auth).digest("hex");
    if(req.query.room == undefined && (config.godword == auth || (config.kingwords && config.kingwords.includes(auth)) || (config.lowkingwords && config.lowkingwords.includes(auth)))){
        let roomobj = {}
        Object.keys(rooms).forEach(room=>{
            roomobj[room] = {
                members: Object.keys(rooms[room].users).length,
                owner: rooms[room].users[rooms[room].ownerID] == undefined ? {id: 0} : rooms[room].users[rooms[room].ownerID].public,
                uptime: rooms[room].reg,
                logins: rooms[room].loginCount,
                messages: rooms[room].msgsSent
            }
        })
        res.write(JSON.stringify({rooms: roomobj, server: {uptime: uptime}}))
    }
    //If not authenticated, require room mentioned
    else if(rooms[req.query.room] == undefined) res.write(JSON.stringify({error: true}));
    else res.write(JSON.stringify({
        members: Object.keys(rooms[req.query.room].users).length,
        owner: rooms[req.query.room].users[rooms[req.query.room].ownerID] == undefined ? {id: 0} : rooms[req.query.room].users[rooms[req.query.room].ownerID].public,
        uptime: rooms[req.query.room].reg
    }))
    res.end()
    return;
})

// Serve static files safely
try {
    app.use(express.static("./client"));
} catch (e) {
    console.log("Client directory not found, creating basic response");
    app.get("/", (req, res) => {
        res.send("BonziWORLD Server is running on port " + PORT);
    });
}

const server = http.Server(app);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

//Socket.io Server
const io = socketio(server, {
    cors: {
        origin: "*", // Allow all origins for deployment
        methods: ["GET", "POST"]
    },
    pingInterval: 3000,
    pingTimeout: 7000
});

io.on("connection", (socket)=>{
    socket.spams = 0;
    console.log("New connection from:", socket.handshake.headers["origin"]);

    //Set IP info safely
    let forwardedFor = socket.handshake.headers["x-forwarded-for"];
    if(forwardedFor && forwardedFor.split(",").length > 2){
        socket.disconnect();
        return;
    }
    
    // Get IP safely
    socket.ip = socket.handshake.headers["cf-connecting-ip"] || 
                (forwardedFor ? forwardedFor.split(",")[0].trim() : 
                socket.handshake.address);

    // Generate GUID for the socket
    socket.guid = guidgen();

    if(bancheck(socket.guid) >= 0){
        commands.bancount++;
        socket.emit("ban", {
            id: socket.guid,
            bannedby: "SYSTEM", 
            reason: commands.reasons[bancheck(socket.guid)] || "Banned"
        });
        socket.disconnect();
        return;
    }

    //ANTIFLOOD
    if(socket.handshake.headers["referer"] == undefined || socket.handshake.headers["user-agent"] == undefined){
        socket.disconnect();
        return;
    }
    
    if(ipinfo[socket.ip] == undefined) ipinfo[socket.ip] = {count: 0};
    ipinfo[socket.ip].count++;

    socket.onAny((a, b)=>{
        socket.spams++;
        if(socket.spams >= 200){
            socket.disconnect();
        }
    })
    
    setInterval(()=>{
        socket.spams = 0;
    }, 10000)
    
    //Join
    new user(socket);
})

console.log("BonziWORLD Server running on port: " + PORT)

//GUID Generator
function guidgen(){
    let guid = Math.round(Math.random() * 999999998+1).toString();
    while(guid.length < 9) guid = "0"+guid;
    //Validate
    let allUsers = [];
    Object.keys(rooms).forEach((room)=>{
        allUsers = allUsers.concat(Object.keys(rooms[room].users));
    })
    while(allUsers.find(e=>{return e.public && e.public.guid == guid}) != undefined){
        guid = Math.round(Math.random() * 999999999).toString();
        while(guid.length < 9) guid = "0"+guid;
    }
    return guid;
}

//Rooms
class room{
    constructor(name, owner, priv){
        this.name = name;
        this.users = {};
        this.usersPublic = {};
        this.ownerID = owner;
        this.private = priv;
        this.reg = 0;
        this.msgsSent = 0;
        this.cmdsSent = 0;
        this.loginCount = 0;
    }
    emit(event, content){
        Object.keys(this.users).forEach(user=>{
            if(this.users[user].socket.connected) {
                this.users[user].socket.emit(event, content);
            }
        })
    }
}

//Make a room, make rooms available to commands
const rooms = {
    default: new room("default", 0, false),
    desanitize: new room("desanitize", 0, false),
    BonziTV: new room("BonziTV", 2, false),
}
commands.rooms = rooms;

//Client
class user{
    constructor(socket){
        this.socket = socket;
        this.loggedin = false;
        this.level = 0;
        this.sanitize = "true";
        this.slowed = false;
        this.spamlimit = 0;
        this.lastmsg = "";
        //0 = none, 1 = yes, 2 = no
        this.vote = 0;
        this.smute = false;

        //Login handler
        this.socket.on("login", logindata=>{
            if(!commands.vpnLocked || isVPN(socket.ip) == 1) this.login(logindata);
            else{
                if(isVPN(socket.ip) == 2) this.socket.emit("error", "PLEASE TURN OFF YOUR VPN (Temporary VPN Block)")
                else{
                    // Simplified VPN check for deployment
                    const http = require('http');
                    http.get("http://ip-api.com/json/"+socket.ip+"?fields=proxy,hosting", res=>{
                        let data = '';
                        res.on("data", chunk=>{
                            data += chunk;
                        });
                        res.on("end", ()=>{
                            try{
                                const d = JSON.parse(data);
                                if(d.proxy || d.hosting){
                                    initializeFile("./config/vpncache.txt", socket.ip+"/true\n");
                                    commands.vpncache.push([socket.ip, "true"])
                                }
                                else{
                                    initializeFile("./config/vpncache.txt", socket.ip+"/false\n");
                                    commands.vpncache.push([socket.ip, "false"])
                                    if(socket.connected) this.login(logindata);
                                }
                            }catch(exc){
                                console.log("ERROR PARSING IP LOOKUP, allowing connection");
                                if(socket.connected) this.login(logindata);
                            }
                        });
                    }).on("error", (err) => {
                        console.log("VPN check failed, allowing connection");
                        if(socket.connected) this.login(logindata);
                    });
                }
            }
        })
    }

    login(logindata){
        if(this.loggedin) return;
        //Data validation and sanitization
        if(ipinfo[this.socket.ip].clientslowmode){
            this.socket.emit("error", "PLEASE WAIT 10 SECONDS BEFORE JOINING AGAIN!");
            return;
        }
        else if(logindata.color == undefined) logindata.color = "";
        if(typeof logindata != 'object' || typeof logindata.name != 'string' || typeof logindata.color != 'string' || typeof logindata.room != 'string'){
            this.socket.emit("error", "TYPE ERROR: INVALID DATA TYPE SENT.");
            return;
        }

        ipinfo[this.socket.ip].clientslowmode = true;
        setTimeout(()=>{
            ipinfo[this.socket.ip].clientslowmode = false;
        }, config.clientslowmode)

        if(logindata.room == "desanitize") this.sanitize = false;
        logindata.name =  sanitize(logindata.name);
        if(checkBlacklist(logindata.name) && this.level < 1) logindata.name = "I SEND IP GRABBERS!";
        if(logindata.name.length > config.maxname){
            this.socket.emit("error", "ERROR: Name too long. Change your name.");
            return;
        }
        logindata.name = markUpName(logindata.name);

        //Setup
        this.loggedin = true;
        if(logindata.room.replace(/ /g,"") == "") logindata.room = "default";
        if(logindata.name.rtext.replace(/ /g,"") == "") logindata.name = markUpName(config.defname);
        if(commands.ccblacklist.includes(logindata.color)) logindata.color = "";
        else if(logindata.color.startsWith("http")) logindata.color = sanitize(logindata.color).replace(/&amp;/g, "&")
        else logindata.color = logindata.color.toLowerCase();
        this.public = {
            guid: guidgen(),
            name: logindata.name.rtext,
            dispname: logindata.name.mtext,
            color: (colors.includes(logindata.color) || logindata.color.startsWith("http")) ? logindata.color : colors[Math.floor(Math.random()*colors.length)] ,
            tagged: false,
            locked: false,
            muted: false,
            tag: "",
            voice: {
                pitch: 15+Math.round(Math.random()*110),
                speed: 125+Math.round(Math.random()*150),
                wordgap: 0
            },
            typing: "",
            joined: 0
        }
        //Join room
        if(rooms[logindata.room] == undefined){
            rooms[logindata.room] = new room(logindata.room, this.public.guid, true);
            this.level = 1;
        }
        rooms[logindata.room].emit("join", this.public);
        this.room = rooms[logindata.room];
        this.room.usersPublic[this.public.guid] = this.public;
        this.room.users[this.public.guid] = this;

        //Tell client to start
        this.socket.emit("login", {
            e7qqM5aje7qqM5ajroomname: logindata.room,
            roompriv: this.room.private,
            owner: this.public.guid == this.room.ownerID,
            users: this.room.usersPublic,
            level: this.level
        })
        
        // Webhook disabled for deployment to avoid errors
        // if(logindata.room == "default") webhooksay("SERVER", "https://bworgmirror.ddnsking.com/profiles/server.png", this.public.name+" HAS JOINED BONZIWORLD!");
        
        commands.lip = this.socket.ip;
        this.room.loginCount++;
        
        //Talk handler
        this.socket.on("talk", (text)=>{
            try{
                if(typeof text != 'string' || markup(text).rtext.replace(/ /g, "") == '' && this.sanitize || this.slowed || this.public.muted) return;
                text = this.sanitize ? sanitize(text.replace(/{NAME}/g, this.public.name).replace(/{COLOR}/g, this.public.color)) : text;
                if(text.length > config.maxmessage && this.sanitize) return;
                text = text.trim();
                if(text.substring(0, 10) ==  this.lastmsg.substring(0, 10) || text.substring(text.length-10, text.length) == this.lastmsg.substring(this.lastmsg.length - 10, this.lastmsg.length)) this.spamlimit++;
                else this.spamlimit = 0
                if(this.spamlimit >= config.spamlimit) return;
                this.lastmsg = text;
                this.slowed = true;
                setTimeout(()=>{this.slowed = false}, config.slowmode)
                if(checkBlacklist(text) && this.level < 1) text = "GUYS LOOK OUT I SEND IP GRABBERS! DON'T TRUST ME!";
                text = markup(text);
                if(this.smute){
                    this.socket.emit("talk", {text: text.mtext, say: text.rtext, guid: this.public.guid})
                    return;
                }

                if(text.rtext == "#standwithisrael"){
                    this.public.tagged = true;
                    this.public.tag = "Israel Supporter";
                    this.room.emit("update", this.public);
                }
                else if(text.rtext == "#freepalestine"){
                    this.public.tagged = true;
                    this.public.color = "allah"
                    this.public.tag = "Terrorist";
                    this.room.emit("update", this.public);
                }
                
                // Webhook disabled for deployment
                // if(this.room.name == "default"){
                //     let mmm = text.rtext.replace(/@/g,"#").split(" ");
                //     let mmm2 = [];
                //     mmm.forEach(m=>{
                //         if(m.replace(/[^abcdefghijklmnopqrstuvwxyz.]/gi, "").includes("...")) mmm2.push("127.0.0.1");
                //         else mmm2.push(m);
                //     })
                //     let mmm3 = mmm2.join(" ");
                //     let avatar =  this.public.color.startsWith("http") ? "https://bworgmirror.ddnsking.com/profiles/crosscolor.png" : ("https://bworgmirror.ddnsking.com/profiles/"+this.public.color+".png");
                //     webhooksay(this.public.name, avatar, mmm3);
                // }
                
                //Room say
                this.room.emit("talk", {text: text.mtext, say: text.rtext, guid: this.public.guid})
                this.room.msgsSent++;
            } catch(exc){
                this.room.emit("announce", {title: "ERROR", html: `
                <h1>MUST REPORT TO FUNE!</h1>
                Send fune a screenshot of this: ${sanitize(exc.toString())}`});
            }
        })

        //Command handler
        this.socket.on("command", comd=>{
            try{
                if(typeof comd != 'object') return;
                if(comd.command == "hail") comd.command = "heil";
                else if(comd.command == "crosscolor" || comd.command == "colour") comd.command = "color";
                if(typeof comd.param != 'string') comd.param = "";
                if(typeof(commands.commands[comd.command]) != 'function' || this.slowed || this.public.muted || comd.param.length > 10000 || this.smute) return;
                if(comd.param.length > config.maxmessage && this.sanitize || (config.runlevels && config.runlevels[comd.command] != undefined && this.level < config.runlevels[comd.command])) return;
                this.slowed = true;
                setTimeout(()=>{this.slowed = false}, config.slowmode)
                comd.param = comd.param.replace(/{NAME}/g, this.public.name).replace(/{COLOR}/g, this.public.color);

                if(checkBlacklist(comd.param) && this.level < 1) comd.param = "GUYS LOOK OUT I SEND IP GRABBERS! DON'T TRUST ME!";

                if(this.lastmsg == comd.command) this.spamlimit++;
                else this.spamlimit = 0
                if(this.spamlimit >= config.spamlimit && comd.command != "vote") return;
                this.lastmsg = comd.command;

                commands.commands[comd.command](this, this.sanitize ? sanitize(comd.param) : comd.param);
                this.room.cmdsSent++;
            } catch(exc){
                this.room.emit("announce", {title: "ERROR", html: `
                <h1>MUST REPORT TO FUNE!</h1>
                Send fune a screenshot of this: ${sanitize(exc.toString())}`});
            }
        })

        //Leave handler
        this.socket.on("disconnect", ()=>{
            // Webhook disabled for deployment
            // if(this.room.name == "default") webhooksay("SERVER", "https://bworgmirror.ddnsking.com/profiles/server.png", this.public.name+" HAS LEFT!");
            
            this.room.emit("leave", this.public.guid);
            delete this.room.usersPublic[this.public.guid];
            delete this.room.users[this.public.guid];
            if(Object.keys(this.room.users).length <= 0 && this.room.private) delete rooms[this.room.name];
            //Transfer ownership
            else if(this.room.ownerID == this.public.guid){
                this.room.ownerID = this.room.usersPublic[Object.keys(this.room.usersPublic)[0]].guid;
                this.room.users[this.room.ownerID].level = 1;
                this.room.users[this.room.ownerID].socket.emit("update_self", {
                    level: this.room.users[this.room.ownerID].level,
                    roomowner: true
                })
            }
        })

        //Check if user typing
        this.socket.on("typing", state=>{
            if(this.public.muted || typeof state != "number") return;
            let lt = this.public.typing;
            if(state == 2) this.public.typing = "<br>(commanding)";
            else if(state == 1) this.public.typing = "<br>(typing)";
            else this.public.typing = "";
            if(this.public.typing != lt) this.room.emit("update", this.public);
        })
    }
}

function sanitize(text){
    //Return undefined if no param. Return sanitized if param exists.
    if(text == undefined) return undefined;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\[/g, "&lbrack;");
}

function desanitize(text){
    return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lbrack;/g, "[");
}

function webhooksay(name, avatar, msg){
    // Disabled for deployment to avoid errors
    return;
}

// Create necessary config files on startup
try {
    initializeFile("./config/server-settings.json", JSON.stringify({
        port: PORT,
        maxname: 20,
        maxmessage: 500,
        slowmode: 1000,
        clientslowmode: 10000,
        spamlimit: 5,
        defname: "Bonzi",
        godword: "",
        kingwords: [],
        lowkingwords: []
    }, null, 2));
    
    initializeFile("./config/colors.txt", "red\nblue\ngreen\nyellow\npurple");
    
    initializeFile("./config/jokes.json", JSON.stringify({
        start: [[{type: 0, text: "Why did the monkey cross the road?"}]],
        middle: [[{type: 0, text: "I don't know, why?"}]],
        end: [[{type: 0, text: "To get to the other side!"}]]
    }, null, 2));
    
    initializeFile("./config/facts.json", JSON.stringify([
        [{type: 0, text: "BonziWORLD is the best virtual world!"}]
    ], null, 2));
    
    initializeFile("./config/copypastas.json", JSON.stringify({
        triggered: [{type: 0, text: "I'm triggered!"}],
        linux: [{type: 0, text: "I use Arch btw"}],
        pawn: [{type: 0, text: "You've been pawned!"}]
    }, null, 2));
    
} catch (e) {
    console.log("Error creating config files:", e.message);
}
