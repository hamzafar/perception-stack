/*
 * replay.js
 *
 * MEMORY-ONLY CAMERA DIAGNOSTIC
 *
 * Purpose:
 *   Test whether intermittent dashboard lag is caused by
 *   JPEG fetch/decode/cache activity.
 *
 * Camera images:
 *   - 4 JPEGs are loaded once
 *   - decoded once into ImageBitmap
 *   - kept in browser memory
 *   - reused for every replay frame
 *
 * Perception data:
 *   - real perception.csv
 *   - still updates at 10 FPS
 *
 * IMPORTANT:
 *   This is a diagnostic version.
 *   It intentionally uses the same four camera images
 *   for every frame.
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

    const CSV_PATH =
        "data/perception.csv";

    const DATASET_PATH =
        "data";

    const TARGET_FPS =
        10.0;

    const PRINT_EVERY =
        50;


    // =========================================================
    // PerceptionReplay
    // =========================================================

    class PerceptionReplay {

        constructor() {

            this.csvPath =
                CSV_PATH;

            this.datasetPath =
                DATASET_PATH;

            this.targetFps =
                TARGET_FPS;

            this.printEvery =
                PRINT_EVERY;

            this.frameCount =
                0;

            this.totalFrames =
                0;

            this.rows =
                [];

            this.rowIndex =
                0;

            this.running =
                false;

            this.timer =
                null;

            // -------------------------------------------------
            // Four decoded images kept permanently in memory.
            //
            // Example:
            //
            // this.memoryImages.front.bitmap
            // this.memoryImages.rear.bitmap
            // -------------------------------------------------

            this.memoryImages =
                {};

            this.memoryImagesReady =
                false;
        }


        // =====================================================
        // Decode CSV value
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

                return JSON.parse(
                    value
                );

            } catch (_) {

                return value;
            }
        }


        // =====================================================
        // CSV parser
        // Handles JSON fields containing commas.
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

                const ch =
                    text[i];


                if (quoted) {

                    if (ch === '"') {

                        if (
                            text[i + 1] === '"'
                        ) {

                            field += '"';

                            i++;

                        } else {

                            quoted =
                                false;
                        }

                    } else {

                        field += ch;
                    }

                    continue;
                }


                if (ch === '"') {

                    quoted =
                        true;

                } else if (
                    ch === ","
                ) {

                    row.push(
                        field
                    );

                    field =
                        "";

                } else if (
                    ch === "\n"
                ) {

                    row.push(
                        field
                    );

                    rows.push(
                        row
                    );

                    row =
                        [];

                    field =
                        "";

                } else if (
                    ch !== "\r"
                ) {

                    field += ch;
                }
            }


            if (
                field.length > 0 ||
                row.length > 0
            ) {

                row.push(
                    field
                );

                rows.push(
                    row
                );
            }


            if (
                rows.length === 0
            ) {

                return [];
            }


            const headers =
                rows[0];


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

                    const object =
                        {};

                    headers.forEach(
                        (
                            header,
                            index
                        ) => {

                            object[header] =
                                values[index] ??
                                "";
                        }
                    );

                    return object;
                });
        }


        // =====================================================
        // Prepare dashboard payload
        // =====================================================

        preparePayload(row) {

            const payload =
                {};


            // -------------------------------------------------
            // Decode CSV fields
            // -------------------------------------------------

            for (
                const [
                    key,
                    value
                ]
                of Object.entries(row)
            ) {

                if (
                    value === null ||
                    value === undefined
                ) {

                    continue;
                }


                payload[key] =
                    this.decodeCsvValue(
                        value
                    );
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
                    String(
                        frameId
                    ).match(
                        /(\d+)$/
                    );


                if (match) {

                    payload.frame_idx =
                        Number(
                            match[1]
                        );
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

                cameras =
                    {};
            }


            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                let cameraData =
                    cameras[
                        cameraName
                    ];


                if (
                    !cameraData ||
                    typeof cameraData !== "object" ||
                    Array.isArray(cameraData)
                ) {

                    cameraData =
                        {};
                }


                if (
                    !Array.isArray(
                        cameraData.boxes
                    )
                ) {

                    cameraData.boxes =
                        [];
                }


                cameras[
                    cameraName
                ] =
                    cameraData;
            }


            payload.cameras =
                cameras;


            return payload;
        }


        // =====================================================
        // Load one camera image
        //
        // This happens ONLY ONCE per camera.
        // =====================================================

        async loadMemoryImage(
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


            console.log(
                "[MemoryTest] Loading:",
                imagePath
            );


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


            if (
                typeof createImageBitmap !==
                "function"
            ) {

                throw new Error(
                    "createImageBitmap() " +
                    "is required for this diagnostic."
                );
            }


            // -------------------------------------------------
            // Resize to approximately the dashboard display
            // resolution so we don't keep unnecessarily huge
            // decoded images in memory.
            // -------------------------------------------------

            let resizeHeight;


            if (
                cameraName === "front"
            ) {

                resizeHeight =
                    560;

            } else {

                resizeHeight =
                    220;
            }


            const bitmap =
                await createImageBitmap(
                    blob,
                    {
                        resizeHeight:
                            resizeHeight
                    }
                );


            console.log(
                "[MemoryTest] Decoded:",
                cameraName,
                bitmap.width +
                "x" +
                bitmap.height
            );


            return {
                bitmap:
                    bitmap
            };
        }


        // =====================================================
        // Preload four images into memory
        //
        // IMPORTANT:
        // We intentionally use frame_000001 only.
        //
        // Every replay frame will reuse these same decoded
        // ImageBitmaps.
        // =====================================================

        async preloadCameraMemory() {

            console.log(
                "[MemoryTest] -------------------------"
            );

            console.log(
                "[MemoryTest] Loading four camera images..."
            );

            console.log(
                "[MemoryTest] These images will remain " +
                "in memory for the entire test."
            );


            const testFrameId =
                "frame_000001";


            const start =
                performance.now();


            const results =
                await Promise.all(
                    CAMERA_NAMES.map(
                        async cameraName => {

                            const asset =
                                await this.loadMemoryImage(
                                    cameraName,
                                    testFrameId
                                );

                            return [
                                cameraName,
                                asset
                            ];
                        }
                    )
                );


            for (
                const [
                    cameraName,
                    asset
                ]
                of results
            ) {

                this.memoryImages[
                    cameraName
                ] =
                    asset;
            }


            const elapsed =
                performance.now() -
                start;


            this.memoryImagesReady =
                true;


            console.log(
                "[MemoryTest] ========================="
            );

            console.log(
                "[MemoryTest] FOUR CAMERA IMAGES READY"
            );

            console.log(
                "[MemoryTest] Initial load:",
                elapsed.toFixed(2),
                "ms"
            );

            console.log(
                "[MemoryTest] No camera fetch/decode " +
                "will occur during replay."
            );

            console.log(
                "[MemoryTest] ========================="
            );
        }


        // =====================================================
        // Load CSV
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
                        cache:
                            "no-store"
                    }
                );


            if (!response.ok) {

                throw new Error(
                    "CSV not found: " +
                    this.csvPath
                );
            }


            const text =
                await response.text();


            this.rows =
                this.parseCsv(
                    text
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
                "[PerceptionReplay] CSV loaded:",
                this.totalFrames,
                "frames"
            );
        }


        // =====================================================
        // Publish one frame
        //
        // IMPORTANT:
        // There is NO fetch() here.
        // There is NO createImageBitmap() here.
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


            const payload =
                this.preparePayload(
                    row
                );


            // -------------------------------------------------
            // Attach the SAME four in-memory ImageBitmaps
            // to every replay frame.
            // -------------------------------------------------

            for (
                const cameraName
                of CAMERA_NAMES
            ) {

                Object.assign(
                    payload.cameras[
                        cameraName
                    ],
                    this.memoryImages[
                        cameraName
                    ]
                );
            }


            // -------------------------------------------------
            // Reset trajectory at beginning of replay.
            // -------------------------------------------------

            if (
                this.rowIndex === 0
            ) {

                payload.trajectory_reset =
                    true;
            }


            // -------------------------------------------------
            // Dashboard
            // -------------------------------------------------

            if (
                typeof window.updateDashboard !==
                "function"
            ) {

                throw new Error(
                    "window.updateDashboard() " +
                    "was not found."
                );
            }


            window.updateDashboard(
                payload
            );


            this.frameCount++;


            if (
                this.printEvery > 0 &&
                this.frameCount %
                    this.printEvery === 0
            ) {

                console.log(
                    "[MemoryTest] Published",
                    this.frameCount,
                    "frames",
                    "(" +
                    payload.frame_id +
                    ")"
                );
            }


            this.rowIndex++;


            if (
                this.rowIndex >=
                this.totalFrames
            ) {

                console.log(
                    "[MemoryTest] Replay complete:",
                    this.frameCount,
                    "frames"
                );


                this.rowIndex =
                    0;

                this.frameCount =
                    0;
            }
        }


        // =====================================================
        // Replay
        // =====================================================

        async replay() {

            if (
                this.running
            ) {

                return;
            }


            this.running =
                true;


            console.log(
                "[MemoryTest] Starting..."
            );


            // -------------------------------------------------
            // Load CSV first.
            // -------------------------------------------------

            await this.loadCsv();


            // -------------------------------------------------
            // IMPORTANT:
            // Decode the four camera images BEFORE playback.
            // -------------------------------------------------

            await this.preloadCameraMemory();


            // -------------------------------------------------
            // Reset replay.
            // -------------------------------------------------

            this.rowIndex =
                0;

            this.frameCount =
                0;


            if (
                typeof window.updateDashboard ===
                "function"
            ) {

                window.updateDashboard({

                    trajectory_reset:
                        true,

                    replay_total_frames:
                        this.totalFrames
                });
            }


            const framePeriod =
                this.targetFps > 0
                    ? 1000 /
                      this.targetFps
                    : 0;


            console.log(
                "[MemoryTest] Target:",
                this.targetFps,
                "FPS"
            );

            console.log(
                "[MemoryTest] Frame period:",
                framePeriod,
                "ms"
            );


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


                    const start =
                        performance.now();


                    try {

                        await this.publishFrame();

                    } catch (error) {

                        console.error(
                            "[MemoryTest]",
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


                    const elapsed =
                        performance.now() -
                        start;


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
        // Stop
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
                "[MemoryTest] Stopped."
            );
        }
    }


    // =========================================================
    // Global
    // =========================================================

    window.PerceptionReplay =
        PerceptionReplay;


    // =========================================================
    // Start automatically
    // =========================================================

    window.addEventListener(
        "load",
        () => {

            const replay =
                new PerceptionReplay();

            window.perceptionReplay =
                replay;

            replay.replay();
        }
    );

})();