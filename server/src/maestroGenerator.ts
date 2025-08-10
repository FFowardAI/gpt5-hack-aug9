import { JobRecord } from ".";


export async function generateMaestroScripts(record: JobRecord): Promise<string[]> {
    console.log('generating maestro script', record);

    return ['maestro script heres'];
}