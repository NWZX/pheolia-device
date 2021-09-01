import * as env from 'dotenv';
env.config();
import { Gpio } from 'onoff';
import {exec} from 'child_process';
import { readFileSync, writeFile, writeFileSync, existsSync } from 'fs';
import { machineIdSync } from 'node-machine-id';
import firebase from 'firebase'
import _ from 'underscore';
import {ERechargeDevicesState} from 'pheolia-common'

export interface IConfig {
    linkedID: string;
    uid?: string;
    name: string;
    message: string;
    state: ERechargeDevicesState;
    currentPower: number;
    currentTimeStart: number;
    powerMode: {
        type: 'DC' | 'AC';
        power: number;
        price: number;
        billing: 'time' | 'session';
    }[];
    localisation: {
        lat: number;
        lng: number;
    };
    createdAt: number;
    updatedAt: number;
}



const powerPort = new Map<number, Gpio>();
let detectorPort: Gpio | undefined;
let rechargeDeviceSnap: firebase.firestore.DocumentSnapshot<firebase.firestore.DocumentData> | null = null;

const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;
const CONFIG_FILE = process.env.CONFIG_FILE;

const timerStep = async (ref: firebase.firestore.DocumentReference, needBackOnline = false) => {
    setTimeout(() => {
        ref.set(
            {
                state: needBackOnline ? ERechargeDevicesState.AVAILABLE : undefined,
                updatedAt: firebase.firestore.Timestamp.now().toMillis(),
            },
            { merge: true },
        );
        timerStep(ref);
    }, 60000);
};

export const main = async (): Promise<void> => {
    try {
        console.log('Initialization Hardware')
        const POWER_PORT = process.env.POWER_PORT;
        const DETECTOR_PORT = process.env.DETECTOR_PORT;
        if (!POWER_PORT || !DETECTOR_PORT) {
            throw new Error('Missing environment variable');
        }
        try {
            const portPower = JSON.parse(POWER_PORT) as { port: number, power: number }[];

            const check:number[] = [];
            portPower.forEach((v) => {
                if (!check.includes(v.port)) {
                    const tgpio = new Gpio(v.port, 'out');
                    powerPort.set(v.power, tgpio);
                    tgpio.writeSync(1);
                    check.push(v.port);
                }
            })

            const port = Number.parseInt(DETECTOR_PORT);
            detectorPort = new Gpio(port, 'in', 'both', { debounceTimeout: 10 });
        } catch (error) {
            throw new Error(error)
        }
        

        console.log('Initialization Software');
        const UID = machineIdSync();

        if (!FIREBASE_CONFIG || !CONFIG_FILE) {
            throw new Error('Missing environment variable');
        }

        if (!existsSync(CONFIG_FILE)) {
            throw new Error("Invalid config path");
            
        }

        let CONFIG: IConfig | undefined;
        try {
            const configUnformat = readFileSync(CONFIG_FILE, 'utf-8');
            CONFIG = JSON.parse(configUnformat) as IConfig;
        } catch (error) {
            throw new Error("Unreadable config file");
        }

        firebase.initializeApp(JSON.parse(FIREBASE_CONFIG));
        firebase.firestore().settings({ ignoreUndefinedProperties: true });
        var db = firebase.firestore();

        rechargeDeviceSnap = await db.collection('rechargeDevices').doc(CONFIG.linkedID).get();
        if (!rechargeDeviceSnap.exists) {
            const rechargeDevicesSnap = await db.collection('rechargeDevices').where('uid', '==', UID).get();
            if (!rechargeDevicesSnap.empty) {
                rechargeDeviceSnap = rechargeDevicesSnap.docs[0];
            } else {
                throw new Error('Device not registered into database');
            }
            
        }

        CONFIG = { ...rechargeDeviceSnap.data() as IConfig, linkedID: rechargeDeviceSnap.id };

        if (!CONFIG.uid) {
            rechargeDeviceSnap.ref.set({ uid: UID } as Partial<IConfig>, { merge: true });
            CONFIG.uid = UID;
        }

        const onNext = (snapshot: firebase.firestore.DocumentSnapshot<firebase.firestore.DocumentData>): void => {
            const snapData = { ...snapshot.data() as IConfig, linkedID: snapshot.id };
            CONFIG ? CONFIG.updatedAt = snapData.updatedAt : null;

            if (!_.isEqual(snapData, CONFIG)) {
                console.log(snapData.updatedAt, " ", CONFIG?.updatedAt);
                //Update offline config
                CONFIG = snapData;
                writeFile(CONFIG_FILE, JSON.stringify(CONFIG), (err) => {
                    if (err) {
                        console.error(err);
                    }
                });

                if (snapData.state == ERechargeDevicesState.STOP) {
                    exec('shutdown now', function (error, stdout, stderr) {
                        console.error(stdout);
                    });
                } else if (
                    snapData.state == ERechargeDevicesState.PEDDING &&
                    snapData.currentPower > 0 &&
                    snapData.currentTimeStart == 0
                ) {
                    let modeExist = false;
                    snapData.powerMode.forEach(
                        (v) => (modeExist = !modeExist ? v.power == snapData.currentPower : true),
                    );
                    const gpio = powerPort.get(snapData.currentPower);
                    if (gpio && modeExist) {
                        gpio.write(0);
                        snapshot.ref.set(
                            {
                                state: ERechargeDevicesState.UNAVAILABLE,
                                message: 'Power cable locked (charging)',
                                updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                                currentTimeStart: firebase.firestore.Timestamp.now().toMillis(),
                            },
                            { merge: true },
                        );
                    } else {
                        snapshot.ref.set(
                            {
                                state: ERechargeDevicesState.ERROR,
                                message: 'Power selected unavalable',
                                updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                                currentPower: 0,
                                currentTimeStart: 0,
                            },
                            { merge: true },
                        );
                    }
                } else {
                    console.log('Action unrequired');
                }
            }
        }
        //Doccument update loop
        db.collection('rechargeDevices').doc(CONFIG.linkedID).onSnapshot({ next: onNext });
        timerStep(rechargeDeviceSnap.ref, CONFIG.state == ERechargeDevicesState.OFFLINE); //Update status loop (To check if device is online)
        //Vehicule connection loop
        console.log('Ready');
        detectorPort.watch((err, value) => {
            if (err) {
                throw err;
            }
            
            
            if (value) {
                if (CONFIG && firebase.firestore.Timestamp.now().toMillis() - CONFIG.updatedAt < 80000) {
                        rechargeDeviceSnap?.ref.set(
                            {
                                state: ERechargeDevicesState.PEDDING,
                                message: 'Power cable connected',
                                updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                                currentPower: 0,
                                currentTimeStart: 0,
                            },
                            { merge: true },
                        );
                    }
                    
                } else {
                powerPort.forEach((v) => v.write(1));
                if (CONFIG && firebase.firestore.Timestamp.now().toMillis() - CONFIG.updatedAt < 80000) {
                    rechargeDeviceSnap?.ref.set(
                        {
                            state: ERechargeDevicesState.AVAILABLE,
                            message: 'Power cable disconnected',
                            updatedAt: firebase.firestore.Timestamp.now().toMillis(),
                            currentPower: 0,
                            currentTimeStart: 0,
                        },
                        { merge: true },
                    );
                }
                    
                }
        })
    } catch (error) {
        console.error(error);
    }
    

}
main();
process.on('SIGINT', async (_) => {
    await rechargeDeviceSnap?.ref.set(
        {
            state: ERechargeDevicesState.OFFLINE,
            message: 'Charger offline',
            updatedAt: firebase.firestore.Timestamp.now().toMillis(),
            currentPower: 0,
            currentTimeStart: 0,
        },
        { merge: true },
    );
    if (CONFIG_FILE) {
        const CONFIG = { ...rechargeDeviceSnap?.data(), linkedID: rechargeDeviceSnap?.id };
        writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG));
    }
    console.log('Set Offline');
    powerPort.forEach((v) => {
        v.unexport();
    });
    detectorPort?.unexport();
    console.log('Port disconnected');
    console.log('Closing...');
    process.exit(0);
});
