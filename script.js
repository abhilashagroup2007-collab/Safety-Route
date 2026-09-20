const API = window.location.protocol === "file:"
    ? "https://onrender.com"
    : "/api";

let map;

let currentLocation = null;

let destinationLocation = null;

let routeLayers = [];

let poiLayers = [];

let evidenceLayers = [];

let locationLayers = [];

function formatDuration(totalSeconds) {
    let remaining = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const days = Math.floor(remaining / 86400);
    remaining %= 86400;
    const hours = Math.floor(remaining / 3600);
    remaining %= 3600;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    return [
        `${days} day${days === 1 ? "" : "s"}`,
        `${hours} hour${hours === 1 ? "" : "s"}`,
        `${minutes} minute${minutes === 1 ? "" : "s"}`,
        `${seconds} second${seconds === 1 ? "" : "s"}`
    ].join(" / ");
}

async function requestJSON(url, options) {
    let response;

    try {
        response = await fetch(url, options);
    } catch (error) {
        throw new Error(
            "Safe Route server is not running. Start it with: npm start, then open http://localhost:5000"
        );
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
        throw new Error(data.message || `Request failed (${response.status})`);
    }

    return data;
}


/* =====================================================
   MAP
===================================================== */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        map =
            L.map("map")
            .setView(
                [18.78, 73.35],
                9
            );


        const satelliteLayer = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            {
                attribution: "Tiles &copy; Esri",
                maxZoom: 19
            }
        ).addTo(map);

        const streetLayer = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
            {
                attribution: "Tiles &copy; Esri, OpenStreetMap contributors",
                maxZoom: 19
            }
        );

        L.control.layers(
            {
                "Satellite": satelliteLayer,
                "Street map": streetLayer
            },
            null,
            { collapsed: false }
        ).addTo(map);

        loadSafetyEvidence();


        document
            .getElementById("locationBtn")
            .addEventListener(
                "click",
                getLocation
            );


        document
            .getElementById("routeBtn")
            .addEventListener(
                "click",
                findRoutes
            );

        document
            .getElementById("continuePaymentBtn")
            .addEventListener(
                "click",
                continueToPayment
            );

        document
            .getElementById("upiPayButton")
            .addEventListener(
                "click",
                openUpiPayment
            );

        document
            .getElementById("submitUtrBtn")
            .addEventListener(
                "click",
                submitUtr
            );

        document
            .getElementById("checkPaymentStatusBtn")
            .addEventListener(
                "click",
                () => checkPaymentStatus(
                    document.getElementById("paymentOrderId").textContent
                )
            );

        restorePaymentStatus();
    }
);


/* =====================================================
   MESSAGE
===================================================== */

function message(text) {

    document
        .getElementById("message")
        .textContent = text;

}


/* =====================================================
   GPS
===================================================== */

function getLocation() {

    message(
        "Requesting GPS location..."
    );


    if (
        !navigator.geolocation
    ) {

        message(
            "This browser does not support GPS."
        );

        return;
    }


    navigator.geolocation.getCurrentPosition(

        position => {

            currentLocation = {

                lat:
                    position.coords.latitude,

                lon:
                    position.coords.longitude

            };


            document
                .getElementById("start")
                .value =
                `${currentLocation.lat.toFixed(6)}, ${currentLocation.lon.toFixed(6)}`;


            L.marker(
                [
                    currentLocation.lat,
                    currentLocation.lon
                ]
            )
            .addTo(map)
            .bindPopup(
                "Your current GPS location"
            )
            .openPopup();

            showUserLocation();
            loadSafetyContext();


            map.setView(
                [
                    currentLocation.lat,
                    currentLocation.lon
                ],
                12
            );


            message(
                "GPS location detected."
            );

        },


        error => {

            console.error(error);

            message(
                "GPS permission/location could not be obtained."
            );

        },

        {

            enableHighAccuracy:
                true,

            timeout:
                15000,

            maximumAge:
                0

        }

    );

}


/* =====================================================
   GEOCODE
===================================================== */

async function geocode(query) {

    const data = await requestJSON(
        `${API}/geocode?q=${encodeURIComponent(query)}`
    );


    if (
        !data.success ||
        !data.results.length
    ) {

        throw new Error(
            "Place not found inside the pilot corridor."
        );

    }


    return data.results[0];

}

async function loadSafetyEvidence() {
    try {
        const response = await fetch(`${API}/blackspots`);
        const data = await response.json();

        (data.data.locations || []).forEach(spot => {
            const marker = L.circleMarker(
                [Number(spot.latitude), Number(spot.longitude)],
                {
                    radius: 8,
                    color: "#9b1c31",
                    fillColor: "#e53935",
                    fillOpacity: 0.85,
                    weight: 2
                }
            ).addTo(map);

            marker.bindPopup(`
                <strong>Official black spot</strong><br>
                ${spot.location}<br>
                Road: ${spot.road || "Not specified"}<br>
                Source: Maharashtra Highway Traffic Police<br>
                <strong>Precaution:</strong> reduce speed, keep extra distance and avoid stopping on the carriageway.
            `);

            evidenceLayers.push(marker);
        });
    } catch (error) {
        console.error("Safety evidence loading failed:", error);
    }
}

function showUserLocation() {
    locationLayers.forEach(layer => map.removeLayer(layer));

    const marker = L.circleMarker(
        [currentLocation.lat, currentLocation.lon],
        {
            radius: 9,
            color: "#075985",
            fillColor: "#38bdf8",
            fillOpacity: 0.95,
            weight: 3
        }
    ).addTo(map);

    marker.bindPopup("<strong>Your current location</strong><br>Blue marker: GPS position.");
    locationLayers.push(marker);
}

function showDestinationLocation() {
    const marker = L.circleMarker(
        [destinationLocation.latitude, destinationLocation.longitude],
        {
            radius: 9,
            color: "#166534",
            fillColor: "#4ade80",
            fillOpacity: 0.95,
            weight: 3
        }
    ).addTo(map);

    marker.bindPopup(
        `<strong>Destination</strong><br>${destinationLocation.name || "Selected destination"}<br>Green marker: destination.`
    );
    locationLayers.push(marker);
}


/* =====================================================
   FIND ROUTES
===================================================== */

async function findRoutes() {

    const start = document.getElementById("start").value.trim();
    const destination =
        document
            .getElementById("destination")
            .value
            .trim();


    if (!destination) {

        message(
            "Enter a destination."
        );

        return;
    }


    try {

        message(
            "Locating both places..."
        );

        if (start && !currentLocation) {
            const sourceLocation = await geocode(start);
            currentLocation = {
                lat: sourceLocation.latitude,
                lon: sourceLocation.longitude
            };
            showUserLocation();
            loadSafetyContext();
        } else if (!currentLocation) {
            throw new Error("Enter a source or allow GPS location first.");
        }


        destinationLocation =
            await geocode(
                destination
            );

        showDestinationLocation();


        await calculateRoutes();


    } catch (error) {

        console.error(error);

        message(error.message || "Route search failed. Please try again.");

    }

}


/* =====================================================
   ROUTE CALCULATION
===================================================== */

async function calculateRoutes() {

    clearRoutes();


    message(
        "Calculating practical routes and checking verified safety evidence..."
    );


    const params =
        new URLSearchParams({

            startLat:
                currentLocation.lat,

            startLon:
                currentLocation.lon,

            endLat:
                destinationLocation.latitude,

            endLon:
                destinationLocation.longitude,

            mode:
                document.getElementById("travelMode").value,

            period:
                document.getElementById("travelPeriod").value

        });


    const data = await requestJSON(`${API}/route?${params}`);


    drawRoutes(
        data.routes
    );


    renderRouteCards(
        data.routes
    );


    message(
        `${data.routes.length} road-network route alternative(s) found. Every returned alternative is shown below for your choice.`
    );

}


/* =====================================================
   ROUTE COLOUR
===================================================== */

function routeColor(zone) {

    switch(zone) {

        case "RED":
            return "#e53935";

        case "ORANGE":
            return "#f57c00";

        case "YELLOW":
            return "#fbc02d";

        case "GREEN":
            return "#2e9b58";

        default:
            return "#777777";

    }

}


/* =====================================================
   DRAW ROUTES
===================================================== */

function drawRoutes(routes) {

    routes.forEach(
        (route, index) => {

            const points =
                route.geometry.coordinates
                .map(
                    point => [
                        point[1],
                        point[0]
                    ]
                );


            const line =
                L.polyline(
                    points,
                    {

                        color:
                            routeColor(
                                route.zone
                            ),

                        weight:
                            index === 0
                                ? 8
                                : 5,

                        opacity:
                            index === 0
                                ? 1
                                : .65

                    }
                )
                .addTo(map);

            line.routeId = route.id;


            line.bindPopup(
                createPopup(
                    route
                )
            );


            routeLayers.push(
                line
            );

            const routePin = L.marker(
                points[Math.floor(points.length / 2)],
                {
                    icon: L.divIcon({
                        className: "route-location-pin",
                        html: `<span>${route.rank}</span>`,
                        iconSize: [30, 30],
                        iconAnchor: [15, 15]
                    }),
                    zIndexOffset: 500 + route.rank
                }
            ).addTo(map);

            routePin.bindPopup(
                `<strong>Route ${route.rank} location symbol</strong><br>` +
                "Select this route card to prefer this alternative."
            );
            locationLayers.push(routePin);

        }
    );

    if (
        routeLayers.length
    ) {

        const group =
            L.featureGroup(
                routeLayers
            );

        map.fitBounds(
            group.getBounds(),
            {
                padding:
                    [30,30]
            }
        );

    }

}


/* =====================================================
   POPUP
===================================================== */

function createPopup(route) {

    const score =
        route.score === null
            ? "N/A"
            : `${route.score}/100`;


    return `

        <strong>
            Route ${route.rank}
        </strong>

        <br><br>

        Distance:
        ${route.distance_km} km

        <br>

        Estimated time:
        ${formatDuration(route.duration_seconds || route.duration_minutes * 60)}

        <br>

        Mode / period:
        ${route.travel_mode || "car"} / ${route.travel_period || "morning"}

        <br>

        Evidence score:
        ${score}

        <br>

        Risk band:
        ${route.zone}

        <br><br>

        ${
            route.message
        }

    `;

}


/* =====================================================
   ROUTE CARDS
===================================================== */

function renderRouteCards(
    routes
) {

    const container =
        document
            .getElementById(
                "routeCards"
            );


    container.innerHTML = "";


    routes.forEach(
        (route, index) => {

            const card =
                document.createElement(
                    "div"
                );


            card.className =
                "route-card";

            card.dataset.routeId = route.id;


            const zoneClass =
                route.zone === "RED"
                    ? "badge-red"

                    : route.zone === "ORANGE"
                    ? "badge-orange"

                    : route.zone === "YELLOW"
                    ? "badge-yellow"

                    : route.zone === "GREEN"
                    ? "badge-green"

                    : "badge-gray";


            const score =
                route.score === null
                    ? "No score"
                    : `${route.score}/100`;


            let evidenceHTML =
                "";


            if (
                route.evidence.length
            ) {

                evidenceHTML =
                    route.evidence
                    .slice(0,3)
                    .map(
                        e =>
                            `
                            <p>
                                <b>
                                    ${e.type}
                                </b>
                                —
                                ${e.location}
                                (${e.distance_km} km)
                            </p>
                            `
                    )
                    .join("");

            }

            else {

                evidenceHTML =
                    `
                    <p>
                        No verified evidence found
                        close enough to this route.
                        This does NOT mean the route
                        is guaranteed safe.
                    </p>
                    `;

            }


            card.innerHTML = `

                <span
                    class="route-badge ${zoneClass}"
                >
                    ${route.zone}
                </span>


                <h3>
                    Route ${route.rank}
                </h3>


                <p>
                    📏
                    ${route.distance_km}
                    km
                </p>


                <p>
                    <span class="route-location-symbol">⌖</span>
                    Route ${route.rank} alternative
                </p>


                <p>
                    ⏱️
                    ${formatDuration(route.duration_seconds || route.duration_minutes * 60)}
                </p>

                <p class="route-mode-note">
                    ${route.travel_mode || "car"} estimate · ${route.travel_period || "morning"} traffic
                </p>


                <p>
                    🛡️
                    Evidence score:
                    <strong>
                        ${score}
                    </strong>
                </p>


                <hr>


                ${evidenceHTML}


                <button
                    class="choose-button"
                    onclick="chooseRoute('${route.id}')"
                >
                    Prefer this route
                </button>

            `;


            container.appendChild(
                card
            );

        }
    );


    /*
     * Tell user to choose rather than
     * silently declaring one route "safest".
     */

    const question =
        document.createElement(
            "div"
        );


    question.style =
        "grid-column:1/-1;padding:20px;background:#f3efff;border-radius:15px;font-weight:700";


    question.innerHTML =
        "Which route do you prefer? You can choose based on safety evidence, distance or estimated time.";


    container.prepend(
        question
    );

}


/* =====================================================
   CHOOSE ROUTE
===================================================== */

function chooseRoute(
    routeId
) {

    const selectedLayer = routeLayers.find(
        layer => layer.routeId === routeId
    );

    if (!selectedLayer) {
        message("This route is no longer available. Please compare routes again.");
        return;
    }

    routeLayers.forEach(layer => {
        layer.setStyle({
            weight: layer.routeId === routeId ? 9 : 4,
            opacity: layer.routeId === routeId ? 1 : .35
        });
        if (layer.routeId === routeId) {
            layer.bringToFront();
        }
    });

    document.querySelectorAll(".route-card").forEach(card => {
        const selected = card.dataset.routeId === routeId;
        card.classList.toggle("route-card-selected", selected);

        const button = card.querySelector(".choose-button");
        if (button) {
            button.textContent = selected
                ? "Selected route"
                : "Prefer this route";
        }
    });

    selectedLayer.openPopup();
    map.fitBounds(selectedLayer.getBounds(), { padding: [45, 45] });
    localStorage.setItem("safeRouteSelectedRoute", routeId);


    message(
        `Route ${routeId} selected. The highlighted line is your preferred route.`
    );

}


/* =====================================================
   NEARBY SEARCH
===================================================== */

async function searchNearby(
    type
) {

    if (!currentLocation) {

        message(
            "Enable GPS first so nearby places are searched around you."
        );

        return;
    }


    message(
        `Searching nearby ${type}...`
    );


    try {

        const response =
            await fetch(

                `${API}/nearby?` +

                new URLSearchParams({

                    lat:
                        currentLocation.lat,

                    lon:
                        currentLocation.lon,

                    radius:
                        10000,

                    q:
                        type

                })

            );


        const data =
            await response.json();


        poiLayers.forEach(
            marker =>
                map.removeLayer(
                    marker
                )
        );


        poiLayers = [];


        data.places.forEach(
            place => {

                const marker =
                    L.marker(
                        [
                            place.latitude,
                            place.longitude
                        ]
                    )
                    .addTo(map)
                    .bindPopup(
                        `
                        <strong>
                            ${place.name}
                        </strong>

                        <br>

                        ${place.category}

                        <br>

                        ${place.distance_km} km away
                        `
                    );


                poiLayers.push(
                    marker
                );

            }
        );

        message(
            `${data.places.length} nearby ${type} place(s) found from OpenStreetMap data.`
        );


    } catch(error) {

        console.error(error);

        message(
            "Nearby place search failed."
        );

    }

}


/* =====================================================
   CLEAR ROUTES
===================================================== */

function clearRoutes() {

    routeLayers.forEach(
        layer =>
            map.removeLayer(
                layer
            )
    );


    routeLayers = [];

}


/* =====================================================
   PREMIUM
===================================================== */

function openPremium() {

    document
        .getElementById(
            "premiumModal"
        )
        .classList
        .remove("hidden");

}


function closePremium() {

    document
        .getElementById(
            "premiumModal"
        )
        .classList
        .add("hidden");

}


/* =====================================================
   PAYMENT
===================================================== */

async function continueToPayment() {
    const name = document.getElementById("userName").value.trim();
    const email = document.getElementById("userEmail").value.trim();
    const phone = document.getElementById("userPhone").value.trim();

    if (!name || !email || !phone) {
        alert("Please enter your name, email and mobile number.");
        return;
    }

    try {
        const response = await fetch(`${API}/payment/create`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name,
                email,
                phone
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Payment creation failed");
        }

        document.getElementById("continuePaymentBtn").disabled = true;
        document.getElementById("paymentStep2").hidden = false;

        document.getElementById("paymentOrderId").textContent =
            data.orderId;

        document.getElementById("ownerPaymentPhone").textContent =
            data.ownerPhone || "Use the UPI payment button";

        const payButton = document.getElementById("upiPayButton");
        const fallbackMessage = document.getElementById("upiFallbackMessage");

        if (data.paymentLink) {
            payButton.dataset.paymentLink = data.paymentLink;
            payButton.dataset.gpayLink = data.paymentLink.replace(
                "upi://pay?",
                "tez://upi/pay?"
            );
            payButton.hidden = false;
            fallbackMessage.hidden = false;
        } else {
            payButton.hidden = true;
            fallbackMessage.hidden = true;
        }

        document.getElementById("paymentStepMessage").textContent = data.message;
        localStorage.setItem("safeRouteOrderId", data.orderId);
        checkPaymentStatus(data.orderId);

    } catch (error) {
        console.error(error);
        document.getElementById("paymentMessage").textContent = error.message;
    }
}

function openUpiPayment() {
    const payButton = document
        .getElementById("upiPayButton")
        .dataset;

    if (!payButton.paymentLink) {
        return;
    }

    window.location.href = payButton.gpayLink || payButton.paymentLink;
}

async function submitUtr() {
    const orderId = document.getElementById("paymentOrderId").textContent;
    const utr = document.getElementById("paymentUtr").value.trim();

    if (!orderId || !utr) {
        document.getElementById("paymentStepMessage").textContent =
            "Enter the UPI transaction ID after completing payment.";
        return;
    }

    try {
        const response = await fetch(`${API}/payment/utr`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ orderId, utr })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.message || "Payment reference submission failed.");
        }

        document.getElementById("paymentStepMessage").textContent = data.message;
        document.getElementById("submitUtrBtn").disabled = true;
        localStorage.setItem("safeRouteOrderId", orderId);
        checkPaymentStatus(orderId);
    } catch (error) {
        document.getElementById("paymentStepMessage").textContent = error.message;
    }
}

async function loadSafetyContext() {
    try {
        const response = await fetch(
            `${API}/safety-context?lat=${currentLocation.lat}&lon=${currentLocation.lon}`
        );
        const data = await response.json();
        document.getElementById("safetyAlert").textContent = data.message;
    } catch (error) {
        document.getElementById("safetyAlert").textContent =
            "Safety context is temporarily unavailable.";
    }
}

async function checkPaymentStatus(orderId) {
    if (!orderId) {
        return;
    }

    try {
        const data = await requestJSON(
            `${API}/payment/status?orderId=${encodeURIComponent(orderId)}`
        );
        const statusMessage = data.verificationStatus === "ACTIVE"
            ? "ACTIVE: payment verified. Premium access is enabled."
            : data.verificationStatus === "INVALID"
                ? "INVALID: this payment reference was rejected. Premium is not active."
                : "PENDING VERIFICATION: the owner must confirm the payment reference.";
        const statusElement = document.getElementById("paymentStepMessage");
        const badgeElement = document.getElementById("paymentStatusBadge");
        const badgeText = data.verificationStatus === "ACTIVE"
            ? "ACTIVE"
            : data.verificationStatus === "INVALID"
                ? "INVALID"
                : "PENDING VERIFICATION";
        statusElement.textContent = statusMessage;
        statusElement.className = `message payment-status-${data.verificationStatus.toLowerCase()}`;
        badgeElement.textContent = badgeText;
        badgeElement.className = `payment-status-badge payment-status-${data.verificationStatus.toLowerCase()}`;
        statusElement.scrollIntoView({ behavior: "smooth", block: "nearest" });

        if (data.verificationStatus === "PENDING") {
            window.clearTimeout(window.paymentStatusTimer);
            window.paymentStatusTimer = window.setTimeout(
                () => checkPaymentStatus(orderId),
                10000
            );
        }
    } catch (error) {
        document.getElementById("paymentStepMessage").textContent = error.message;
    }
}

function restorePaymentStatus() {
    const orderId = localStorage.getItem("safeRouteOrderId");
    if (orderId) {
        checkPaymentStatus(orderId);
    }
}
