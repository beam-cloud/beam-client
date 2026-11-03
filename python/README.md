## CPU capacity tiers

Requires beta9 0.1.294 (included by this release).

```python
from beam import VM

vm = VM("dev", cpu_tier="shared", cpu=4, memory=8192).create()
vm.stop()
vm.update(cpu_tier="performance")
```

`cpu_tier` also applies to CPU functions, sandboxes and services. Spot can be
interrupted; restart preempted VMs explicitly. [Rates and behavior](https://www.beam.cloud/pricing#cpu-capacity).
