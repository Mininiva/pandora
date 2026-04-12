from .freeze_frame import FreezeFrameModel
from .terra       import TerraModel
from .warm_soup   import WarmSoupModel
from .siliconia   import SiliconiaModel
from .boronia     import BoroniaModel
from .iron_veil   import IronVeilModel

BIOME_MODELS = {
    '00': TerraModel,
    '04': WarmSoupModel,
    '10': SiliconiaModel,
    '20': FreezeFrameModel,
    '50': BoroniaModel,
    '70': IronVeilModel,
}
