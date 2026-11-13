"""Generate a synthetic commercial demo set with exact ground truth."""
from pathlib import Path
import pymupdf as pdf
from PIL import Image, ImageDraw
import io

OUT = Path(__file__).resolve().parent / "interior-demo.pdf"

def build():
    doc = pdf.open()
    page = doc.new_page(width=780, height=530)
    def line(a, b, color=(.22,.25,.27), dash=None):
        page.draw_line(a,b,color=color,dashes=dash,width=1.5)
    def rect(a,b,color=(.22,.25,.27)):
        page.draw_rect((*a,*b),color=color,width=1.5)
    def text(at, value, size=11):
        page.insert_text(at,value,fontsize=size)
    def annotate(annotation, content):
        annotation.set_info(content=content)
        annotation.update()
    text((32,35),"D101  |  INTERIOR DEMOLITION PLAN",18)
    text((32,56),"A2Z sandbox fixture  /  One PDF point = 1/12 ft after calibration")
    rect((37,92),(474,369))
    line((40,109),(470,109))
    line((40,350),(470,350))
    line((250,110),(250,350))
    line((40,210),(250,210))
    red=(.8,.12,.18)
    green=(.04,.53,.28)
    line((60,205),(204,205),red,"[6 3] 0")             # 12 LF
    rect((270,120),(390,216),green)                    # 80 SF
    annotate(page.add_line_annot((270,275),(390,275)), "A2Z TAKEOFF: sawcut")  # 10 LF
    annotate(page.add_polygon_annot([(275,291),(347,291),(347,339),(275,339)]),
             "A2Z TAKEOFF: slab THICKNESS=6IN")        # 24 SF, 4/9 CY
    annotate(page.add_polygon_annot([(62,115),(182,115),(182,187),(62,187)]),
             "A2Z TAKEOFF: ceiling")                  # 60 SF
    annotate(page.add_circle_annot((214,194,234,214)), "A2Z TAKEOFF: door")
    annotate(page.add_circle_annot((128,256,146,274)), "A2Z TAKEOFF: fixture")
    annotate(page.add_polyline_annot([(60,300),(96,300),(96,324)]), "A2Z TAKEOFF: millwork")
    annotate(page.add_line_annot((42,401),(162,401)), "A2Z SCALE BAR: 10 FT")
    text((42,422),"10 FT calibration reference")
    text((505,108),"DEMO LEGEND",14)
    line((512,146),(535,146),red,"[6 3] 0")
    text((547,150),"A2Z LEGEND: wall")
    rect((512,171),(535,183),green)
    text((547,182),"A2Z LEGEND: floor")
    text((505,245),"REMOVE FINISHES AS INDICATED")
    text((505,269),"VERIFY FIELD CONDITIONS")
    text((32,505),"D101  /  Controlled geometry and rule evidence")
    rotated=doc.new_page(width=540,height=400)
    rotated.insert_text((35,40),"D102 - ROTATED / CROPPED PLAN")
    annotate(rotated.add_line_annot((100,120),(220,120)), "A2Z SCALE BAR: 10 FT")
    annotate(rotated.add_line_annot((100,170),(196,170)), "A2Z TAKEOFF: wall")
    rotated.set_cropbox(pdf.Rect(25,20,515,380))
    rotated.set_rotation(90)
    scan=doc.new_page(width=780,height=530)
    im=Image.new("RGB",(780,530),"white")
    draw=ImageDraw.Draw(im)
    draw.rectangle((45,80,710,410),outline="black",width=3)
    draw.line((375,80,375,410),fill="black",width=3)
    draw.line((45,245,375,245),fill="black",width=3)
    draw.text((45,40),"D103 - SCANNED PLAN / VERIFY SCALE MANUALLY",fill="black")
    output=io.BytesIO()
    im.save(output,format="PNG")
    scan.insert_image(scan.rect,stream=output.getvalue())
    unknown=doc.new_page(width=780,height=530)
    unknown.insert_text((40,40),"D104 - UNBOUND DEMOLITION NOTES / SCALE 1/4 IN = 1 FT")
    unknown.draw_line((40,100),(150,100))
    unknown.insert_text((50,130),"REMOVE WALL WHERE INDICATED")
    doc.set_page_labels([{"startpage":0,"prefix":"D","style":"D","firstpagenum":101}])
    doc.save(OUT,deflate=True)
    doc.close()

if __name__=="__main__":
    build()
