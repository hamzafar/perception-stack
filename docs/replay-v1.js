/*
 * replay.js
 *
 * Browser equivalent of the Python PerceptionReplay.
 *
 * Expected structure:
 *
 * docs/
 * ├── index.html
 * ├── replay.js
 * └── data/
 *     ├── perception.csv
 *     ├── front/
 *     │   ├── frame_000001.jpg
 *     │   └── ...
 *     ├── rear/
 *     ├── left/
 *     └── right/
 *
 * The existing dashboard must provide:
 *
 *     window.updateDashboard(payload)
 *
 * No Python.
 * No WebSocket.
 * No external libraries.
 */

(function () {

    "use strict";


    // =========================================================
    // Configuration
    // =========================================================

    const CAMERA_NAMES = [
        "front",
        "rear",
        "left",
        "right"
    ];

    const CSV_PATH = "data/perception.csv";

    const DATASET_PATH = "data";

    const TARGET_FPS = 10.0;

    const PRINT_EVERY = 50;


    // =========================================================
    // PerceptionReplay
    // =========================================================

    class PerceptionReplay {

        constructor() {

            this.csvPath = CSV_PATH;

            this.datasetPath = DATASET_PATH;

            this.targetFps = TARGET_FPS;

            this.printEvery = PRINT_EVERY;

            this.frameCount = 0;

            this.totalFrames = 0;

            this.rows = [];

            this.rowIndex = 0;

            this.running = false;

            this.timer = null;
        }


        // =====================================================
        // Decode CSV value
        // Equivalent to Python json.loads()
        // =====================================================

        decodeCsvValue(value) {

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                return value;
            }

            try {

                return JSON.parse(value);

            } catch (error) {

                return value;
            }
        }


        // =====================================================
        // CSV parser
        //
        // Important:
        // Your CSV contains JSON fields with commas, therefore
        // a simple split(",") cannot be used.
        // =====================================================

        parseCsv(text) {

            const rows = [];

            let row = [];

            let field = "";

            let quoted = false;


            for (
                let i = 0;
                i < text.length;
                i++
            ) {

                const character = text[i];


                // ---------------------------------------------
                // Inside quoted CSV field
                // ---------------------------------------------

                if (quoted) {

                    if (character === '"') {

                        // CSV escaped quote:
                        // ""
                        if (
                            text[i + 1] === '"'
                        ) {

                            field += '"';

                            i++;

                        } else {

                            quoted = false;
                        }

                    } else {

                        field += character;
                    }

                    continue;
                }


                // ---------------------------------------------
                // Start quoted field
                // ---------------------------------------------

                if (
                    character === '"'
                ) {

                    quoted = true;

                }

                // ---------------------------------------------
                // Field separator
                // ---------------------------------------------

                else if (
                    character === ','
                ) {

                    row.push(field);

                    field = "";
                }

                // ---------------------------------------------
                // End of row
                // ---------------------------------------------

                else if (
                    character === '\n'
                ) {

                    row.push(field);

                    rows.push(row);

                    row = [];

                    field = "";
                }

                // ---------------------------------------------
                // Ignore CR
                // ---------------------------------------------

                else if (
                    character !== '\r'
                ) {

                    field += character;
                }
            }


            // Last row
            if (
                field.length > 0 ||
                row.length > 0
            ) {

                row.push(field);

                rows.push(row);
            }


            if (
                rows.length === 0
            ) {

                return [];
            }


            const headers = rows[0];


            return rows
                .slice(1)
                .filter(
                    values =>
                        values.some(
                            value =>
                                value !== ""
                        )
                )
                .map(values => {

                    const object = {};


                    headers.forEach(
                        (header, index) => {

                            object[header] =
                                values[index] ?? "";
                        }
                    );


                    return object;
                });
        }


        // =====================================================
        // Prepare dashboard payload
        // Equivalent to Python _prepare_payload()
        // =====================================================

        preparePayload(row) {

            const payload = {};


            // -------------------------------------------------
            // Decode every CSV field
            // -------------------------------------------------

            for (
                const [key, value]
                of Object.entries(row)
            ) {

                if (
                    value === null ||
                    value === undefined
                ) {

                    continue;
                }


                payload[key] =
                    this.decodeCsvValue(value);
            }


            // -------------------------------------------------
            // Frame ID
            // -------------------------------------------------

            let frameId =
                payload.frame_id;


            if (!frameId) {

                const frameIdx =
                    payload.frame_idx;


                if (
                    frameIdx === undefined ||
                    frameIdx === null ||
                    frameIdx === ""
                ) {

                    throw new Error(
                        "CSV row contains neither " +
                        "'frame_id' nor 'frame_idx'"
                    );
                }


                frameId =
                    "frame_" +
                    String(
                        Number(frameIdx)
                    ).padStart(
                        6,
                        "0"
                    );


                payload.frame_id =
                    frameId;
            }


            // -------------------------------------------------
            // Frame index
            // -------------------------------------------------

            if (
                payload.frame_idx ===
                undefined
            ) {

                const match =
                    String(frameId).match(
                        /(\d+)$/
                    );


                if (match) {

                    payload.frame_idx =
                        Number(match[1]);
                }
            }


            // -------------------------------------------------
            // Cameras
            // -------------------------------------------------

            let cameras =
                payload.cameras;


            if (
                !cameras ||
                typeof cameras !== "object" ||
                Array.isArray(cameras)
            ) {

                cameras = {};
            }


            // -------------------------------------------------
            // Ensure all four cameras exist
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                let cameraData =
                    cameras[cameraName];


                if (
                    !cameraData ||
                    typeof cameraData !== "object" ||
                    Array.isArray(cameraData)
                ) {

                    cameraData = {};
                }


                if (
                    !Array.isArray(
                        cameraData.boxes
                    )
                ) {

                    cameraData.boxes = [];
                }


                cameras[cameraName] =
                    cameraData;
            }


            payload.cameras =
                cameras;


            return payload;
        }


        // =====================================================
        // Load image
        //
        // Python equivalent:
        //
        // open(image, "rb")
        // base64.b64encode(...)
        //
        // Browser equivalent:
        //
        // fetch()
        // Blob
        // FileReader
        // =====================================================

        async loadImageBase64(
            cameraName,
            frameId
        ) {

            const imagePath =
                this.datasetPath +
                "/" +
                cameraName +
                "/" +
                frameId +
                ".jpg";


            const response =
                await fetch(
                    imagePath
                );


            if (!response.ok) {

                throw new Error(
                    "Image not found: " +
                    imagePath
                );
            }


            const blob =
                await response.blob();


            return new Promise(
                (resolve, reject) => {

                    const reader =
                        new FileReader();


                    reader.onload =
                        function () {

                            const result =
                                reader.result;


                            const commaIndex =
                                result.indexOf(",");


                            if (
                                commaIndex >= 0
                            ) {

                                resolve(
                                    result.substring(
                                        commaIndex + 1
                                    )
                                );

                            } else {

                                resolve(result);
                            }
                        };


                    reader.onerror =
                        function () {

                            reject(
                                new Error(
                                    "Failed to read image"
                                )
                            );
                        };


                    reader.readAsDataURL(
                        blob
                    );
                }
            );
        }


        // =====================================================
        // Load all four camera images
        // =====================================================

        async prepareImages(payload) {

            const frameId =
                payload.frame_id;


            await Promise.all(

                CAMERA_NAMES.map(
                    async cameraName => {

                        payload
                            .cameras
                            [cameraName]
                            .image =
                            await this.loadImageBase64(
                                cameraName,
                                frameId
                            );
                    }
                )
            );


            return payload;
        }


        // =====================================================
        // Load CSV
        // Equivalent to _get_total_frames()
        // =====================================================

        async loadCsv() {

            console.log(
                "[PerceptionReplay] " +
                "Loading CSV..."
            );


            const response =
                await fetch(
                    this.csvPath,
                    {
                        cache: "no-store"
                    }
                );


            if (!response.ok) {

                throw new Error(
                    "CSV not found: " +
                    this.csvPath
                );
            }


            const csvText =
                await response.text();


            this.rows =
                this.parseCsv(
                    csvText
                );


            this.totalFrames =
                this.rows.length;


            if (
                this.totalFrames === 0
            ) {

                throw new Error(
                    "CSV contains no data rows."
                );
            }


            console.log(
                "[PerceptionReplay] " +
                "CSV loaded: " +
                this.totalFrames +
                " frames"
            );
        }


        // =====================================================
        // Publish one frame
        // =====================================================

        async publishFrame() {

            if (
                !this.rows.length
            ) {

                return;
            }


            const row =
                this.rows[
                    this.rowIndex
                ];


            // -------------------------------------------------
            // Build payload
            // -------------------------------------------------

            let payload =
                this.preparePayload(
                    row
                );


            // -------------------------------------------------
            // Load four camera images
            // -------------------------------------------------

            payload =
                await this.prepareImages(
                    payload
                );


            // -------------------------------------------------
            // Reset trajectory at start of replay
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Push to existing dashboard
            // -------------------------------------------------

            if (
                typeof window.updateDashboard
                !== "function"
            ) {

                throw new Error(
                    "updateDashboard() " +
                    "was not found in dashboard."
                );
            }


            window.updateDashboard(
                payload
            );


            // -------------------------------------------------
            // Count
            // -------------------------------------------------

            this.frameCount++;


            // -------------------------------------------------
            // Progress
            // -------------------------------------------------

            if (
                this.printEvery > 0 &&
                this.frameCount %
                    this.printEvery === 0
            ) {

                console.log(
                    "[PerceptionReplay] " +
                    "Published " +
                    this.frameCount +
                    " frames " +
                    "(current: " +
                    payload.frame_id +
                    ")"
                );
            }


            // -------------------------------------------------
            // Next CSV row
            // -------------------------------------------------

            this.rowIndex++;


            // -------------------------------------------------
            // Replay finished
            // -------------------------------------------------

            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[PerceptionReplay] " +
                    "Replay complete: " +
                    this.frameCount +
                    " frames published."
                );


                // Restart from frame 1
                this.rowIndex = 0;

                this.frameCount = 0;
            }
        }


        // =====================================================
        // Start continuous replay
        // =====================================================

        async replay() {

            if (
                this.running
            ) {

                return;
            }


            this.running = true;


            console.log(
                "[PerceptionReplay] " +
                "Starting replay..."
            );


            console.log(
                "[PerceptionReplay] " +
                "Target FPS: " +
                this.targetFps
            );


            await this.loadCsv();


            // -------------------------------------------------
            // Reset replay state
            // -------------------------------------------------

            this.rowIndex = 0;

            this.frameCount = 0;


            // -------------------------------------------------
            // Tell dashboard total frame count
            // -------------------------------------------------

            if (
                typeof window.updateDashboard
                === "function"
            ) {

                window.updateDashboard({

                    trajectory_reset: true,

                    replay_total_frames:
                        this.totalFrames
                });
            }


            const framePeriod =
                this.targetFps > 0
                    ? 1000 /
                      this.targetFps
                    : 0;


            // -------------------------------------------------
            // Replay loop
            // -------------------------------------------------

            const loop =
                async () => {

                    if (
                        !this.running
                    ) {

                        return;
                    }


                    const startTime =
                        performance.now();


                    try {

                        await this.publishFrame();

                    } catch (error) {

                        console.error(
                            "[PerceptionReplay]",
                            error
                        );


                        this.stop();

                        return;
                    }


                    if (
                        !this.running
                    ) {

                        return;
                    }


                    // Maximum speed
                    if (
                        framePeriod <= 0
                    ) {

                        this.timer =
                            setTimeout(
                                loop,
                                0
                            );

                        return;
                    }


                    // -------------------------------------------------
                    // Maintain target FPS
                    // -------------------------------------------------

                    const elapsed =
                        performance.now() -
                        startTime;


                    const delay =
                        Math.max(
                            0,
                            framePeriod -
                            elapsed
                        );


                    this.timer =
                        setTimeout(
                            loop,
                            delay
                        );
                };


            loop();
        }


        // =====================================================
        // Stop replay
        // =====================================================

        stop() {

            this.running =
                false;


            if (
                this.timer !== null
            ) {

                clearTimeout(
                    this.timer
                );


                this.timer =
                    null;
            }


            console.log(
                "[PerceptionReplay] " +
                "Replay stopped."
            );
        }
    }


    // =========================================================
    // Make class accessible globally
    // =========================================================

    window.PerceptionReplay =
        PerceptionReplay;


    // =========================================================
    // Automatically start when dashboard loads
    // =========================================================

    window.addEventListener(
        "load",
        function () {

            const replay =
                new PerceptionReplay();


            window.perceptionReplay =
                replay;


            replay.replay();
        }
    );

})();