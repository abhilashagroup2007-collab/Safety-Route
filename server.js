require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const multer = require("multer");

const app = express();

const PORT = process.env.PORT || 5000;

const DATA_DIR = path.join(__dirname, "data");
const SAFETY_DOCUMENTS_DIR = path.join(DATA_DIR, "safety_documents");
const sessions = new Map();

fs.mkdirSync(SAFETY_DOCUMENTS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname, { index: false }));

const safetyUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 10 }
});


/* =====================================================
   DATABASE HELPERS
===================================================== */

function file(name) {
    return path.join(DATA_DIR, name);
}

function readJSON(name, fallback) {

    try {

        const p = file(name);

        if (!fs.existsSync(p)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(p, "utf8")
        );

    } catch (error) {

        console.error(
            "JSON ERROR:",
            name,
            error.message
        );

        return fallback;
    }
}


function writeJSON(name, data) {

    fs.writeFileSync(
        file(name),
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function passwordMatches(password, storedHash) {
    try {
        const [salt, expected] = String(storedHash).split(":");
        const actual = crypto.scryptSync(password, salt, 64).toString("hex");
        return crypto.timingSafeEqual(
            Buffer.from(actual, "hex"),
            Buffer.from(expected, "hex")
        );
    } catch (error) {
        return false;
    }
}

function publicUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        canUpload: user.canUpload === true
    };
}

function sessionUser(req) {
    const token = String(req.headers.authorization || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    return sessions.get(token) || null;
}

function authRequired(req, res, next) {
    const user = sessionUser(req);

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Please log in to continue."
        });
    }

    req.authUser = user;
    next();
}

function users() {
    return readJSON("users.json", []);
}

function saveUsers(data) {
    writeJSON("users.json", data);
}

function createOrderId(payments) {
    let orderId;

    do {
        orderId =
            "SR-" +
            Date.now() +
            "-" +
            crypto.randomBytes(4).toString("hex").toUpperCase();
    } while (payments.some(payment => payment.orderId === orderId));

    return orderId;
}

function createMailer() {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return null;
    }

    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

async function sendVerificationEmail(payment) {
    const mailer = createMailer();

    if (!mailer || !(process.env.SMTP_FROM || process.env.SMTP_USER)) {
        return false;
    }

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: payment.email,
        subject: "Safe Route Premium payment verified",
        text:
            `Your Safe Route Premium payment for order ${payment.orderId} ` +
            `has been verified. Premium access is now active.`
    });

    return true;
}

async function sendOwnerPaymentEmail(subject, payment, statusMessage) {
    const mailer = createMailer();
    const ownerEmail = process.env.OWNER_EMAIL;

    if (!mailer || !(process.env.SMTP_FROM || process.env.SMTP_USER) || !ownerEmail) {
        return false;
    }

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ownerEmail,
        subject,
        text:
            `Safe Route Premium status: ${statusMessage}\n\n` +
            `Order: ${payment.orderId}\n` +
            `User: ${payment.name}\n` +
            `Email: ${payment.email}\n` +
            `Phone: ${payment.phone || "Not provided"}\n` +
            `Amount: ${payment.currency} ${payment.amount}\n` +
            `UTR: ${payment.utr || "Not submitted"}\n` +
            `Status: ${payment.status}\n` +
            `Premium active: ${payment.premiumActivated ? "YES" : "NO"}\n` +
            `Created: ${payment.createdAt}`
    });

    return true;
}

async function notifyOwner(subject, payment, statusMessage) {
    try {
        return await sendOwnerPaymentEmail(subject, payment, statusMessage);
    } catch (error) {
        console.error("OWNER EMAIL ERROR:", error.message);
        return false;
    }
}

async function sendOwnerPaymentReport(payments) {
    const mailer = createMailer();
    const ownerEmail = process.env.OWNER_EMAIL;

    if (!mailer || !(process.env.SMTP_FROM || process.env.SMTP_USER) || !ownerEmail) {
        return false;
    }

    const lines = payments.map(payment =>
        `${payment.orderId} | ${payment.name} | ${payment.email} | ` +
        `${payment.currency} ${payment.amount} | UTR: ${payment.utr || "none"} | ` +
        `Status: ${payment.status} | Premium: ${payment.premiumActivated ? "ACTIVE" : "INACTIVE"}`
    );

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ownerEmail,
        subject: "Safe Route Premium user status report",
        text: `Official Safe Route Premium user status report\n\n${lines.join("\n") || "No premium users yet."}`
    });

    return true;
}

async function sendSafetyReport(report) {
    const mailer = createMailer();
    const ownerEmail = process.env.OWNER_EMAIL;

    if (!mailer || !(process.env.SMTP_FROM || process.env.SMTP_USER) || !ownerEmail) {
        return false;
    }

    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: ownerEmail,
        subject: "Safe Route unsafe-zone report",
        text:
            `A user reported a safety concern on Safe Route.\n\n` +
            `Zone: ${report.zone}\n` +
            `Location: ${report.location}\n` +
            `Incident type: ${report.incidentType}\n` +
            `Details: ${report.details}\n` +
            `Reporter: ${report.email || "Not provided"}`
    });

    return true;
}

function safetyDocuments() {
    const uploadedDocuments = fs.readdirSync(SAFETY_DOCUMENTS_DIR)
        .map(name => {
            const documentPath = path.join(SAFETY_DOCUMENTS_DIR, name);
            const stats = fs.statSync(documentPath);
            const metadataPath = `${documentPath}.meta.json`;
            const metadata = fs.existsSync(metadataPath)
                ? readJSON(path.join("safety_documents", `${name}.meta.json`), {})
                : {};

            return {
                name,
                originalName: metadata.originalName || name,
                mimeType: metadata.mimeType || "application/octet-stream",
                size: stats.size,
                uploadedAt: metadata.uploadedAt || stats.mtime.toISOString(),
                url: `/safety-documents/${encodeURIComponent(name)}`
            };
        })
        .filter(document =>
            document.name !== ".gitkeep" &&
            !document.name.endsWith(".meta.json")
        )
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    const links = readJSON("safety_links.json", []);
    return [...uploadedDocuments, ...links]
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}


/* =====================================================
   LOAD DATA
===================================================== */

const accidentData =
    readJSON("accident_zone.json", {});

const crimeData =
    readJSON("crime_zone.json", {});

const blackspotData =
    readJSON(
        "blackspots.json",
        { locations: [] }
    );

const hazardData =
    readJSON(
        "hazard_zone.json",
        { zones: [] }
    );

const corridorData =
    readJSON(
        "corridor.json",
        {}
    );

let safetyPointData =
    readJSON(
        "safety_points.json",
        { points: [] }
    );

function getSafetyPoints() {
    const ownerPoints = (safetyPointData.points || []).map(point => ({
        ...point,
        zone: ["RED", "ORANGE", "YELLOW", "GREEN"].includes(
            String(point.zone || "").toUpperCase()
        ) ? String(point.zone).toUpperCase() : "UNKNOWN",
        incident_types: point.incident_types || ["Reported road incident"],
        image_url: point.image_url || null
    }));

    const ownerCoordinates = ownerPoints.map(point => [
        Number(point.latitude),
        Number(point.longitude)
    ]);

    const legacyPoints = (blackspotData.locations || [])
        .filter(spot => !ownerCoordinates.some(([lat, lon]) =>
            distanceKm(lat, lon, Number(spot.latitude), Number(spot.longitude)) < 0.2
        ))
        .map((spot, index) => ({
            ...spot,
            id: spot.id || `BLACKSPOT-${index + 1}`,
            sequence: ownerPoints.length + index + 1,
            incident_types: ["Vehicle collision", "Fatal crash"],
            incident_summary: "Official black-spot record with reported road incidents.",
            incident_count: Object.values(spot.accidents || {})
                .reduce((total, count) => total + Number(count || 0), 0),
            fatality_count: Object.values(spot.fatalities || {})
                .reduce((total, count) => total + Number(count || 0), 0),
            source_name: "Maharashtra Highway Traffic Police",
            source_url: blackspotData.source_url || null,
            image_url: null
        }));

    return [...ownerPoints, ...legacyPoints]
        .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}


/* =====================================================
   HOME
===================================================== */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
                "index.html"
        ),
        { headers: { "Cache-Control": "no-store" } }
    );

});

app.get("/app", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/auth/register", (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || password.length < 8) {
        return res.status(400).json({
            success: false,
            message: "Name, email and a password of at least 8 characters are required."
        });
    }

    if (email === String(process.env.OWNER_EMAIL || "").toLowerCase()) {
        return res.status(409).json({
            success: false,
            message: "The permanent owner account cannot be registered again."
        });
    }

    const registeredUsers = users();
    if (registeredUsers.some(user => user.email === email)) {
        return res.status(409).json({
            success: false,
            message: "An account with this email already exists."
        });
    }

    const user = {
        id: `user-${crypto.randomUUID()}`,
        name,
        email,
        passwordHash: hashPassword(password),
        role: "USER",
        canUpload: false,
        createdAt: new Date().toISOString()
    };

    registeredUsers.push(user);
    saveUsers(registeredUsers);

    res.status(201).json({
        success: true,
        message: "Account created. You can now log in.",
        user: publicUser(user)
    });
});

app.post("/api/auth/login", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim().replace(/\s+/g, " ");
    const password = String(req.body.password || "");
    const requestedRole = String(req.body.role || "USER").toUpperCase();
    const configuredOwnerName = String(process.env.OWNER_NAME || "")
        .trim()
        .replace(/\s+/g, " ");
    let user = null;

    if (
        (email === String(process.env.OWNER_EMAIL || "").toLowerCase() ||
            name.toLowerCase() === configuredOwnerName.toLowerCase()) &&
        process.env.OWNER_PASSWORD &&
        password === process.env.OWNER_PASSWORD
    ) {
        user = {
            id: "owner",
            name: process.env.OWNER_NAME || "Safety Route Owner",
            email: process.env.OWNER_EMAIL,
            role: "OWNER",
            canUpload: true
        };
    } else {
        user = users().find(candidate =>
            candidate.email === email &&
            passwordMatches(password, candidate.passwordHash)
        );
    }

    if (user && requestedRole === "OWNER" && user.role !== "OWNER") {
        user = null;
    }

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Email or password is incorrect."
        });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, user);

    res.json({
        success: true,
        token,
        user: publicUser(user)
    });
});

app.get("/api/auth/me", authRequired, (req, res) => {
    res.json({ success: true, user: publicUser(req.authUser) });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
    const token = String(req.headers.authorization || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
    sessions.delete(token);
    res.json({ success: true });
});


/* =====================================================
   HEALTH
===================================================== */

app.get("/api/health", (req, res) => {

    res.json({

        success: true,

        project: "Safety Route",

        phase: "Mumbai-Pune Pilot",

        routing: "OSRM",

        pois: "OpenStreetMap Overpass",

        ownerEmail: process.env.OWNER_EMAIL || null,

        emailConfigured: Boolean(
            process.env.SMTP_HOST &&
            process.env.SMTP_USER &&
            process.env.SMTP_PASS
        ),

        timestamp:
            new Date().toISOString()

    });

});


/* =====================================================
   DATA APIS
===================================================== */

app.get("/api/accidents", (req, res) => {

    res.json({
        success: true,
        data: accidentData
    });

});


app.get("/api/crime", (req, res) => {

    res.json({
        success: true,
        data: crimeData
    });

});


app.get("/api/blackspots", (req, res) => {

    res.json({
        success: true,
        data: blackspotData
    });

});

app.get("/api/safety-points", (req, res) => {
    res.json({
        success: true,
        source: safetyPointData.source || null,
        points: getSafetyPoints()
    });
});

app.get("/api/safety-documents", (req, res) => {
    res.json({ success: true, documents: safetyDocuments() });
});

app.get("/safety-documents/:name", (req, res) => {
    const name = path.basename(req.params.name);
    const documentPath = path.join(SAFETY_DOCUMENTS_DIR, name);

    if (!fs.existsSync(documentPath) || name.endsWith(".meta.json")) {
        return res.status(404).send("Safety document not found.");
    }

    res.sendFile(documentPath);
});

app.post(
    "/api/admin/safety-points/upload",
    adminOnly,
    safetyUpload.array("safetyData", 10),
    (req, res) => {
        if (!req.files?.length) {
            return res.status(400).json({
                success: false,
                message: "Choose one or more safety-data files to upload."
            });
        }

        const documents = [];
        const newPoints = [];

        for (const uploadedFile of req.files) {
            const extension = path.extname(uploadedFile.originalname).toLowerCase();
            const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
            const storedPath = path.join(SAFETY_DOCUMENTS_DIR, storedName);

            if (extension === ".json") {
                let uploadedData;

                try {
                    uploadedData = JSON.parse(uploadedFile.buffer.toString("utf8"));
                } catch (error) {
                    return res.status(400).json({
                        success: false,
                        message: `${uploadedFile.originalname} is not valid JSON.`
                    });
                }

                if (!Array.isArray(uploadedData.points)) {
                    return res.status(400).json({
                        success: false,
                        message: `${uploadedFile.originalname} must contain a points array.`
                    });
                }

                const invalidPoint = uploadedData.points.find(point =>
                    !point ||
                    !Number.isFinite(Number(point.latitude)) ||
                    !Number.isFinite(Number(point.longitude))
                );

                if (invalidPoint) {
                    return res.status(400).json({
                        success: false,
                        message: `Every point in ${uploadedFile.originalname} needs numeric latitude and longitude.`
                    });
                }

                newPoints.push(...uploadedData.points);
            }

            fs.writeFileSync(storedPath, uploadedFile.buffer);
            writeJSON(path.join("safety_documents", `${storedName}.meta.json`), {
                originalName: uploadedFile.originalname,
                mimeType: uploadedFile.mimetype,
                uploadedAt: new Date().toISOString()
            });
            documents.push(uploadedFile.originalname);
        }

        if (newPoints.length) {
            safetyPointData = {
                ...safetyPointData,
                points: [...(safetyPointData.points || []), ...newPoints]
            };
            writeJSON("safety_points.json", safetyPointData);
        }

        res.json({
            success: true,
            count: documents.length,
            message: `${documents.length} safety document(s) uploaded and published for users.`
        });
    }
);

app.post("/api/safety-reports", async (req, res) => {
    const { zone, location, incidentType, details, email } = req.body;

    if (!zone || !location || !incidentType || !details) {
        return res.status(400).json({
            success: false,
            message: "Zone, location, incident type and details are required."
        });
    }

    const report = {
        zone,
        location,
        incidentType,
        details,
        email,
        reportedAt: new Date().toISOString()
    };

    const reports = readJSON("safety_reports.json", []);
    reports.push(report);
    writeJSON("safety_reports.json", reports);

    const emailSent = await sendSafetyReport(report).catch(error => {
        console.error("SAFETY REPORT EMAIL ERROR:", error.message);
        return false;
    });

    res.json({
        success: true,
        emailSent,
        message: emailSent
            ? "Your report was sent to the owner."
            : "Your report was saved. Owner email delivery is not configured yet."
    });
});

app.get("/api/safety-context", (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({
            success: false,
            message: "Valid latitude and longitude are required."
        });
    }

    const nearby = getSafetyPoints()
        .map(spot => ({
            ...spot,
            distance_km: Number(distanceKm(
                lat,
                lon,
                Number(spot.latitude),
                Number(spot.longitude)
            ).toFixed(2))
        }))
        .filter(spot => spot.distance_km <= 2)
        .sort((a, b) => a.distance_km - b.distance_km);

    res.json({
        success: true,
        officialBlackspots: nearby,
        nightCrimeDataAvailable: false,
        message: nearby.length
            ? "Official black-spot evidence is nearby. At night, use well-lit roads, reduce speed and avoid stopping alone. No verified night-specific crime alert is available for this location."
            : "No official black-spot record was found within 2 km. This is not a guarantee of safety, and no verified night-specific crime alert is available for this location."
    });
});


app.get("/api/hazards", (req, res) => {

    res.json({
        success: true,
        data: hazardData
    });

});


/* =====================================================
   DISTANCE
===================================================== */

function distanceKm(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371;

    const dLat =
        (lat2 - lat1)
        *
        Math.PI / 180;

    const dLon =
        (lon2 - lon1)
        *
        Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +

        Math.cos(
            lat1 * Math.PI / 180
        ) *

        Math.cos(
            lat2 * Math.PI / 180
        ) *

        Math.sin(dLon / 2) ** 2;

    return (
        R *
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        )
    );

}


/* =====================================================
   ROUTE EVIDENCE ANALYSIS
===================================================== */

function densifyCoordinates(
    coordinates,
    maxSegmentKm = 0.1
) {

    const samples = [];

    for (
        let index = 0;
        index < coordinates.length - 1;
        index += 1
    ) {

        const start = coordinates[index];
        const end = coordinates[index + 1];

        const segmentKm =
            distanceKm(
                start[1],
                start[0],
                end[1],
                end[0]
            );

        const steps = Math.max(
            1,
            Math.ceil(segmentKm / maxSegmentKm)
        );

        for (
            let step = 0;
            step < steps;
            step += 1
        ) {

            const ratio = step / steps;

            samples.push([
                start[0] + (end[0] - start[0]) * ratio,
                start[1] + (end[1] - start[1]) * ratio
            ]);

        }

    }

    if (coordinates.length) {
        samples.push(
            coordinates[coordinates.length - 1]
        );
    }

    return samples;

}

function analyseRoute(
    coordinates
) {

    const evidence = [];

    let penalty = 0;

    const routeSamples =
        densifyCoordinates(coordinates);


    const safetyPoints = getSafetyPoints();


    /* -----------------------------------------------
       BLACKSPOTS
    ------------------------------------------------ */

    for (
        const spot of safetyPoints
    ) {

        let closest = Infinity;

        for (
            const point of routeSamples
        ) {

            const lon = point[0];
            const lat = point[1];

            const d =
                distanceKm(
                    lat,
                    lon,
                    Number(spot.latitude),
                    Number(spot.longitude)
                );

            if (d < closest) {
                closest = d;
            }

        }


        if (closest <= 0.5) {

            penalty += 35;

            evidence.push({

                type: spot.incident_types?.join(" / ") || "REPORTED ROAD INCIDENT",

                severity: "HIGH",

                location:
                    spot.location,

                distance_km:
                    Number(
                        closest.toFixed(2)
                    ),

                source:
                    spot.source_name || "Government safety record",

                incident_summary:
                    spot.incident_summary || "Reported road safety incident.",

                image_url:
                    spot.image_url || null

            });

        }

        else if (closest <= 1) {

            penalty += 20;

            evidence.push({

                type: spot.incident_types?.join(" / ") || "REPORTED ROAD INCIDENT",

                severity: "MEDIUM",

                location:
                    spot.location,

                distance_km:
                    Number(
                        closest.toFixed(2)
                    ),

                source:
                    spot.source_name || "Government safety record",

                incident_summary:
                    spot.incident_summary || "Reported road safety incident.",

                image_url:
                    spot.image_url || null

            });

        }

        else if (closest <= 2) {

            penalty += 8;

            evidence.push({

                type: spot.incident_types?.join(" / ") || "REPORTED ROAD INCIDENT",

                severity: "LOW",

                location:
                    spot.location,

                distance_km:
                    Number(
                        closest.toFixed(2)
                    ),

                source:
                    spot.source_name || "Government safety record",

                incident_summary:
                    spot.incident_summary || "Reported road safety incident.",

                image_url:
                    spot.image_url || null

            });

        }

    }


    /* -----------------------------------------------
       SCORE ONLY WHEN EVIDENCE EXISTS
    ------------------------------------------------ */

    if (evidence.length === 0) {

        return {

            score: null,

            zone: "UNKNOWN",

            evidence: [],

            message:
                "Insufficient verified safety evidence was found close enough to this route."

        };

    }


    const score =
        Math.max(
            0,
            100 - Math.min(
                penalty,
                100
            )
        );


    let zone = "GREEN";


    if (score < 40) {

        zone = "RED";

    }

    else if (score < 65) {

        zone = "ORANGE";

    }

    else if (score < 80) {

        zone = "YELLOW";

    }


    return {

        score,

        zone,

        evidence,

        message:
            "Route band is calculated from verified evidence currently stored in the Safety Route database."

    };

}


/* =====================================================
   GEOCODING
===================================================== */

app.get(
    "/api/geocode",
    async (req, res) => {

        try {

            const q =
                String(
                    req.query.q || ""
                ).trim();


            if (!q) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Enter a destination."

                });

            }


            const response = await axios.get(
                "https://nominatim.openstreetmap.org/search",
                {
                    params: {
                        q,
                        format: "json",
                        limit: 5,
                        countrycodes: "in",
                        viewbox: "72.65,19.50,74.20,18.30"
                    },
                    headers: {
                        "User-Agent": "SafetyRoute/1.0 (route-planner)"
                    },
                    timeout: 10000
                }
            );


            const places = response.data || [];

            if (!places.length) {

                return res.json({

                    success: false,

                    message:
                        "No matching place was found inside the Mumbai-Pune pilot corridor."

                });

            }


            const results =
                places.map(
                    place => ({

                        name:
                            place.display_name,

                        latitude:
                            Number(place.lat),

                        longitude:
                            Number(place.lon)

                    })
                );


            res.json({

                success: true,

                results

            });


        } catch (error) {

            console.error(
                "GEOCODE ERROR:",
                error.message
            );

            res.status(502).json({

                success: false,

                message:
                    "Destination search is temporarily unavailable. Try the place name with its city."

            });

        }

    }
);


/* =====================================================
   NEARBY POI SEARCH
===================================================== */

app.get(
    "/api/nearby",
    async (req, res) => {

        try {

            const lat =
                Number(req.query.lat);

            const lon =
                Number(req.query.lon);

            const query =
                String(
                    req.query.q || "place"
                );

            const radius = Math.min(
                Math.max(
                    Number(req.query.radius) || 10000,
                    1000
                ),
                20000
            );


            if (
                !Number.isFinite(lat) ||
                !Number.isFinite(lon)
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Valid latitude and longitude are required."

                });

            }


            let filter;


            const q =
                query.toLowerCase();


            if (
                q.includes("petrol") ||
                q.includes("fuel")
            ) {

                filter =
                    'node(around:RADIUS,LAT,LON)[amenity=fuel];';

            }

            else if (
                q.includes("hotel")
            ) {

                filter =
                    'nwr(around:RADIUS,LAT,LON)[tourism=hotel];';

            }

            else if (
                q.includes("mall") ||
                q.includes("shopping")
            ) {

                filter =
                    'nwr(around:RADIUS,LAT,LON)[shop=mall];';

            }

            else if (
                q.includes("restaurant") ||
                q.includes("food")
            ) {

                filter =
                    'nwr(around:RADIUS,LAT,LON)[amenity=restaurant];';

            }

            else if (
                q.includes("hospital")
            ) {

                filter =
                    'nwr(around:RADIUS,LAT,LON)[amenity=hospital];';

            }

            else {

                filter =
                    'nwr(around:RADIUS,LAT,LON)[name];';

            }


            filter =
                filter
                .replaceAll(
                    "LAT",
                    lat
                )
                .replaceAll(
                    "LON",
                    lon
                )
                .replaceAll(
                    "RADIUS",
                    radius
                );


            const overpassQuery = `

                [out:json][timeout:20];

                ${filter}

                out center tags;

            `;


            const response =
                await axios.post(

                    "https://overpass-api.de/api/interpreter",

                    overpassQuery,

                    {

                        headers: {

                            "Content-Type":
                                "text/plain",

                            "User-Agent":
                                "SafetyRoute/1.0"

                        }

                    }

                );


            const places =
                (
                    response.data.elements || []
                )
                .filter(
                    item =>
                        item.tags &&
                        item.tags.name
                )
                .map(
                    item => {

                        const p =
                            item.center || item;

                        return {

                            name:
                                item.tags.name,

                            latitude:
                                Number(p.lat),

                            longitude:
                                Number(p.lon),

                            category:
                                item.tags.amenity ||
                                item.tags.shop ||
                                item.tags.tourism ||
                                "place",

                            distance_km:
                                Number(
                                    distanceKm(
                                        lat,
                                        lon,
                                        p.lat,
                                        p.lon
                                    ).toFixed(2)
                                )

                        };

                    }
                )
                .sort(
                    (a, b) =>
                        a.distance_km -
                        b.distance_km
                )
                .slice(0, 30);


            res.json({

                success: true,

                search:
                    query,

                places

            });


        } catch (error) {

            console.error(
                "OVERPASS ERROR:",
                error.message
            );

            res.status(500).json({

                success: false,

                message:
                    "Nearby-place service is temporarily unavailable."

            });

        }

    }
);


/* =====================================================
   ROUTE
===================================================== */

app.get(
    "/api/route",
    async (req, res) => {

        try {

            const startLat =
                Number(req.query.startLat);

            const startLon =
                Number(req.query.startLon);

            const endLat =
                Number(req.query.endLat);

            const endLon =
                Number(req.query.endLon);

            const mode = String(req.query.mode || "car").toLowerCase();
            const period = String(req.query.period || "morning").toLowerCase();

            const modeSpeeds = {
                car: 43,
                bike: 38,
                rail: 65,
                walk: 5
            };

            const trafficMultipliers = {
                morning: 1.05,
                afternoon: 1.12,
                evening: 1.25,
                night: 0.95
            };


            if (
                ![
                    startLat,
                    startLon,
                    endLat,
                    endLon
                ].every(
                    Number.isFinite
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid route coordinates."

                });

            }

            if (!modeSpeeds[mode] || !trafficMultipliers[period]) {
                return res.status(400).json({
                    success: false,
                    message: "Choose a valid travel mode and time of day."
                });
            }


            const url =
                `https://router.project-osrm.org/route/v1/driving/` +

                `${startLon},${startLat};` +

                `${endLon},${endLat}`;


            const routeParams = {
                alternatives: true,
                steps: true,
                overview: "full",
                geometries: "geojson"
            };

            const routingEndpoints = [
                url,
                `https://routing.openstreetmap.de/routed-car/route/v1/driving/` +
                    `${startLon},${startLat};${endLon},${endLat}`
            ];

            let response;
            let lastError;

            for (const endpoint of routingEndpoints) {
                try {
                    response = await axios.get(endpoint, {
                        params: routeParams,
                        timeout: 15000
                    });
                    if (response.data && response.data.code === "Ok") {
                        break;
                    }
                } catch (error) {
                    lastError = error;
                }
            }

            if (!response || response.data?.code !== "Ok") {
                throw lastError || new Error("No route was returned.");
            }


            const osrmRoutes =
                response.data.routes || [];


            const routes =
                osrmRoutes.map(
                    (route, index) => {

                        const distanceKm = route.distance / 1000;
                        const estimatedSeconds = Math.round(
                            distanceKm / modeSpeeds[mode] *
                            3600 * trafficMultipliers[period]
                        );

                        const analysis =
                            analyseRoute(
                                route.geometry.coordinates
                            );


                        return {

                            id:
                                `route-${index + 1}`,

                            rank:
                                index + 1,

                            distance_km:
                                Number(distanceKm.toFixed(2)),

                            duration_minutes:
                                Math.round(
                                    estimatedSeconds / 60
                                ),

                            duration_seconds:
                                estimatedSeconds,

                            travel_mode: mode,

                            travel_period: period,

                            score:
                                analysis.score,

                            zone:
                                analysis.zone,

                            evidence:
                                analysis.evidence,

                            message:
                                analysis.message,

                            geometry:
                                route.geometry

                        };

                    }
                );


            /*
             * Do not pretend the first route is
             * automatically safest.
             *
             * Sort only after considering whether
             * verified evidence exists.
             */

            routes.sort(
                (a, b) => {

                    if (
                        a.score === null &&
                        b.score !== null
                    ) {
                        return 1;
                    }

                    if (
                        a.score !== null &&
                        b.score === null
                    ) {
                        return -1;
                    }

                    if (
                        a.score !== null &&
                        b.score !== null
                    ) {

                        return (
                            b.score -
                            a.score
                        );

                    }

                    return (
                        a.duration_minutes -
                        b.duration_minutes
                    );

                }
            );


            res.json({

                success: true,

                route_count:
                    routes.length,

                routes

            });


        } catch (error) {

            console.error(
                "ROUTE ERROR:",
                error.message
            );

            res.status(502).json({

                success: false,

                message:
                    "The route service is temporarily unavailable. Check your connection and try again."

            });

        }

    }
);


/* =====================================================
   PAYMENT — CREATE PAYMENT RECORD
===================================================== */

app.post(
    "/api/payment/create",
    (req, res) => {

        const {

            name,
            email,
            phone

        } = req.body;


        if (!name || !email) {

            return res.status(400).json({

                success: false,

                message:
                    "Name and email are required."

            });

        }

        if (!process.env.OWNER_UPI_ID) {
            return res.status(503).json({
                success: false,
                message: "Owner payment account is not configured. Add OWNER_UPI_ID to .env."
            });
        }


        const payments =
            readJSON(
                "payments.json",
                []
            );


        const orderId = createOrderId(payments);


        const record = {

            orderId,

            name,

            email,

            phone:
                phone || "",

            amount:
                Number(
                    process.env.PREMIUM_PRICE ||
                    126
                ),

            currency:
                "INR",

            status:
                "PENDING",

            premiumActivated:
                false,

            createdAt:
                new Date().toISOString(),

            ownerPhone:
                process.env.OWNER_PHONE

        };


        payments.push(record);


        writeJSON(
            "payments.json",
            payments
        );

        notifyOwner(
            "New Safe Route Premium payment order",
            record,
            "NEW ORDER - awaiting payment"
        );


        const paymentLink =
            "upi://pay?" +
            new URLSearchParams({
                pa: process.env.OWNER_UPI_ID,
                pn: "Safety Route",
                am: String(record.amount),
                cu: "INR",
                tn: `Safety Route Premium ${orderId}`,
                tr: orderId
            }).toString();


        res.json({

            success: true,

            orderId,

            amount:
                record.amount,

            ownerPhone:
                process.env.OWNER_PHONE,

            paymentLink,

            message:
                "Payment request created for the Safe Route owner account."

        });

    }
);


/* =====================================================
   USER REPORTS UTR
===================================================== */

app.post(
    "/api/payment/utr",
    async (req, res) => {

        const {
            orderId,
            utr
        } = req.body;


        const payments =
            readJSON(
                "payments.json",
                []
            );


        const payment =
            payments.find(
                p =>
                    p.orderId ===
                    orderId
            );


        if (!payment) {

            return res.status(404).json({

                success: false,

                message:
                    "Payment order not found."

            });

        }

        if (!String(utr || "").trim()) {

            return res.status(400).json({

                success: false,

                message:
                    "A UTR or payment reference is required."

            });

        }

        const paymentReference = String(utr).trim();

        if (!/^[A-Za-z0-9-]{6,40}$/.test(paymentReference)) {
            return res.status(400).json({
                success: false,
                message: "Invalid UPI transaction ID. Use the reference shown by your bank app."
            });
        }


        payment.utr = paymentReference;

        payment.status =
            "VERIFIED";

        payment.premiumActivated =
            true;

        payment.verifiedAt =
            new Date().toISOString();

        payment.reportedAt =
            new Date().toISOString();


        writeJSON(
            "payments.json",
            payments
        );

        notifyOwner(
            "Safe Route Premium payment received",
            payment,
            "ACTIVE - payment reference submitted and premium activated"
        );

        let emailSent = false;

        try {
            emailSent = await sendVerificationEmail(payment);
        } catch (error) {
            console.error("PAYMENT EMAIL ERROR:", error.message);
        }


        res.json({

            success: true,

            verificationStatus: "ACTIVE",

            premiumActivated: true,

            emailSent,

            message:
                "Payment reference received. Premium is active now."

        });

    }
);

/* =====================================================
   USER CHECKS PAYMENT STATUS
===================================================== */

app.get(
    "/api/payment/status",
    (req, res) => {
        const orderId = String(req.query.orderId || "").trim();
        const payments = readJSON("payments.json", []);
        const payment = payments.find(item => item.orderId === orderId);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment order not found."
            });
        }

        res.json({
            success: true,
            orderId: payment.orderId,
            status: payment.status,
            verificationStatus: payment.premiumActivated
                ? "ACTIVE"
                : payment.status === "INVALID"
                    ? "INVALID"
                    : "PENDING",
            premiumActivated: payment.premiumActivated === true,
            verifiedAt: payment.verifiedAt || null
        });
    }
);


/* =====================================================
   ADMIN AUTH
===================================================== */

function adminOnly(req, res, next) {
    const user = sessionUser(req);
    const legacyPassword = req.headers["x-admin-password"];

    if (
        !(
            user &&
            (user.role === "OWNER" || user.canUpload === true)
        ) &&
        legacyPassword !== process.env.ADMIN_PASSWORD
    ) {

        return res.status(401).json({

            success: false,

            message:
                "Owner access required."

        });

    }


    next();

}

app.post("/api/admin/users/:userId/access", adminOnly, (req, res) => {
    const registeredUsers = users();
    const user = registeredUsers.find(candidate => candidate.id === req.params.userId);

    if (!user) {
        return res.status(404).json({
            success: false,
            message: "User account not found."
        });
    }

    user.canUpload = req.body.canUpload === true;
    saveUsers(registeredUsers);

    res.json({
        success: true,
        user: publicUser(user),
        message: user.canUpload
            ? "User can now upload owner-approved safety documents."
            : "User upload access removed."
    });
});

app.get("/api/admin/users", adminOnly, (req, res) => {
    res.json({
        success: true,
        users: users().map(publicUser)
    });
});


/* =====================================================
   ADMIN PAYMENTS
===================================================== */

app.get(
    "/api/admin/payments",
    adminOnly,
    (req, res) => {

        const payments =
            readJSON(
                "payments.json",
                []
            );


        res.json({

            success: true,

            payments

        });

    }
);


/* =====================================================
   OWNER VERIFIES PAYMENT
===================================================== */

app.post(
    "/api/admin/payment/verify",
    adminOnly,
    async (req, res) => {

        const {
            orderId
        } = req.body;


        const payments =
            readJSON(
                "payments.json",
                []
            );


        const payment =
            payments.find(
                p =>
                    p.orderId ===
                    orderId
            );


        if (!payment) {

            return res.status(404).json({

                success: false,

                message:
                    "Payment not found."

            });

        }


        payment.status =
            "VERIFIED";

        payment.premiumActivated =
            true;

        payment.verifiedAt =
            new Date().toISOString();


        writeJSON(
            "payments.json",
            payments
        );

        notifyOwner(
            "Safe Route Premium payment verified",
            payment,
            "ACTIVE - payment verified by owner"
        );

        let emailSent = false;

        try {
            emailSent = await sendVerificationEmail(payment);
        } catch (error) {
            console.error("VERIFICATION EMAIL ERROR:", error.message);
        }


        res.json({

            success: true,

            message:
                "Premium payment verified.",

            emailSent,

            payment

        });

    }
);


/* =====================================================
   SERVER
===================================================== */

/* =====================================================
   OWNER MARKS PAYMENT INVALID
===================================================== */

app.post(
    "/api/admin/payment/reject",
    adminOnly,
    (req, res) => {
        const orderId = String(req.body.orderId || "").trim();
        const payments = readJSON("payments.json", []);
        const payment = payments.find(item => item.orderId === orderId);

        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment not found."
            });
        }

        payment.status = "INVALID";
        payment.premiumActivated = false;
        payment.invalidatedAt = new Date().toISOString();
        writeJSON("payments.json", payments);

        notifyOwner(
            "Safe Route Premium payment marked invalid",
            payment,
            "INVALID - payment rejected by owner"
        );

        res.json({
            success: true,
            message: "Payment marked invalid. Premium remains inactive.",
            payment
        });
    }
);

app.post(
    "/api/admin/payments/email-report",
    adminOnly,
    async (req, res) => {
        const payments = readJSON("payments.json", []);
        const emailSent = await sendOwnerPaymentReport(payments).catch(error => {
            console.error("OWNER REPORT EMAIL ERROR:", error.message);
            return false;
        });

        res.json({
            success: true,
            emailSent,
            message: emailSent
                ? "Official premium-user status report sent to the owner email."
                : "Owner email report was not sent. Configure SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM."
        });
    }
);

app.listen(
    PORT,
    () => {
        console.log(`Safe Route running at http://localhost:${PORT}`);
        console.log("Owner status email:", process.env.OWNER_EMAIL || "not configured");
        console.log(
            "SMTP delivery:",
            process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
                ? "CONFIGURED"
                : "NOT CONFIGURED"
        );
    }
);

app.post("/api/admin/safety-documents/link", adminOnly, (req, res) => {
    const title = String(req.body.title || "").trim();
    const url = String(req.body.url || "").trim();

    if (!title || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({
            success: false,
            message: "Enter a title and a valid http or https link."
        });
    }

    const links = readJSON("safety_links.json", []);
    links.push({
        name: `link-${crypto.randomUUID()}`,
        originalName: title,
        mimeType: "Published link",
        size: 0,
        uploadedAt: new Date().toISOString(),
        url
    });
    writeJSON("safety_links.json", links);

    res.json({
        success: true,
        message: "Safety link published for users."
    });
});
