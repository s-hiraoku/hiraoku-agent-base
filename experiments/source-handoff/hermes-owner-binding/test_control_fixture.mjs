// Offline structural fixture only. No filesystem identity or native authority claim.
export function selectionFixture(scope) {
  const home = '/fake/root/profiles/synthetic-profile', control = '/fake/root';
  const endpoint = { profile_id: home, instance_id: 'fake-instance', authority_epoch: 5,
    runtime_protocol: 1, api_origin: 'http://127.0.0.1:12345', control_home: control,
    code_sha: '6705c8c634d83a2f2918aa5ec45e7f8f20c20dc7' };
  const paths = {profile_home:home, profile_lock:home+'/gateway.lock', control_home:control,
    control_lock:control+'/gateway.lock', control_socket:control+'/gateway.sock'};
  const control_paths = Object.fromEntries(Object.entries(paths).map(([key,path], i) => [key,
    {path,dev:1,ino:i+1,uid:process.getuid(),mode:key.endsWith('_home')?0o40700:key.endsWith('_lock')?0o100600:0o140600,nlink:1}]));
  return {profile_home:home,session_cwd:'/fake/work',request_id:'fake',endpoint,control_paths,scope:structuredClone(scope)};
}
