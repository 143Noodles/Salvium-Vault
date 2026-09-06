import os,subprocess,shlex,pathlib
root=pathlib.Path('/repair')
commands=(root/'compile-commands.txt').read_text().splitlines()
rebuilt=[]
for command in commands:
 args=shlex.split(os.path.expandvars(command))
 source=args[args.index('-c')+1];target=args[args.index('-o')+1]
 deps_args=args.copy();deps_args[deps_args.index('-c')]='-MM';deps_args[deps_args.index('-o')+1]='/tmp/audit-width-dependencies.d'
 subprocess.run(deps_args,check=True)
 deps=pathlib.Path('/tmp/audit-width-dependencies.d').read_text()
 if '/ringct/rctTypes.h' not in deps:continue
 print('Rebuilding '+pathlib.Path(target).name,flush=True)
 subprocess.run(args,check=True);rebuilt.append(target)
assert '/workspace/build/wasm_bindings.o' in rebuilt
assert '/workspace/build/cryptonote_format_utils.o' in rebuilt
assert '/workspace/build/wallet2.o' in rebuilt
(root/('rebuilt-'+os.environ['REPAIR_VARIANT']+'.txt')).write_text('\n'.join(rebuilt)+'\n')
print('Rebuilt '+str(len(rebuilt))+' dependent objects',flush=True)
